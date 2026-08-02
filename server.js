import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const TIKHUB_BASE = 'https://api.tikhub.io';

// ---- 读取 .env 里的 TIKHUB_KEY（零依赖，手动解析）----
async function loadEnv() {
  try {
    const raw = await readFile(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* .env 不存在时依赖真实环境变量 */
  }
}
await loadEnv();
const TIKHUB_KEY = process.env.TIKHUB_KEY;
if (!TIKHUB_KEY) {
  console.error('[启动失败] 未找到 TIKHUB_KEY，请在 .env 中配置');
  process.exit(1);
}

// ---- 服务端缓存 ----
// 默认时段（当天）由定时任务每 2 小时主动刷新，前端请求只读缓存，不触发 TikHub 调用；
// 自定义时间段属于少数人工操作，按需拉取并用 60s 兜底缓存
const CACHE_TTL_MS = 60 * 1000;
const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const cache = new Map(); // key -> { at, payload }

async function tikhub(pathAndQuery, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(TIKHUB_BASE + pathAndQuery, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${TIKHUB_KEY}`,
        'User-Agent': 'auto-fetch-demo/1.0',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (json.code !== 200) {
      const msg = json.message || json.detail?.message_zh || json.detail?.message || '';
      throw new Error(`TikHub code=${json.code ?? json.detail?.code ?? res.status} ${msg}`);
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

// 按 from/to（YYYY-MM-DD，本地时区）过滤时间戳（秒）
function inDateRange(ts, from, to) {
  if (!ts) return true;
  if (from && ts < new Date(from + 'T00:00:00').getTime() / 1000) return false;
  if (to && ts > new Date(to + 'T23:59:59').getTime() / 1000) return false;
  return true;
}

const fmt = (n) => (typeof n === 'number' && n > 0 ? n : null);

// 数字转「x.x万」展示
const fmtCount = (n) => (n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : String(n));

// 本地时区 YYYY-MM-DD
const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fmtDate = (ts) => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 三个榜单共用的目标关键词；接口均不支持一次传多个，需逐个调用后合并
const MANJU_KEYWORDS = ['动态漫', 'AI漫剧', '漫剧'];

// 按关键词各拉一次并合并去重（keyFn 取条目唯一 id）；单个关键词失败不拖垮整榜，全部失败才报错
async function fetchMergedByKeywords(fetchOne, keyFn) {
  const settled = await Promise.allSettled(MANJU_KEYWORDS.map(fetchOne));
  if (settled.every((s) => s.status === 'rejected')) throw settled[0].reason;
  settled.forEach((s, i) => {
    if (s.status === 'rejected') console.error(`[关键词 ${MANJU_KEYWORDS[i]}] 拉取失败:`, s.reason?.message);
  });
  const seen = new Set();
  return settled
    .flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
    .filter((it) => {
      const k = keyFn(it);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// ---- 榜单抓取 + 归一化，统一输出 { rank, title, hot, sub, cover }，query 里可带 from/to ----
const boards = {
  'douyin/manju': async (query) => {
    // 抖音热点视频总榜（小时级窗口），三个关键词各过滤一遍后合并
    const objs = await fetchMergedByKeywords(
      (keyword) =>
        tikhub('/api/v1/douyin/billboard/fetch_hot_total_video_list', {
          page: 1,
          page_size: 50,
          date_window: 1,
          sub_type: 1001,
          keyword,
          tags: [],
        }).then((data) => data?.data?.objs || []),
      (o) => o.item_id
    );
    return objs
      .filter((o) => inDateRange(o.publish_time, query.from, query.to))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 50)
      .map((o, i) => ({
        rank: i + 1,
        title: o.item_title || '(无标题)',
        hot: fmt(o.score),
        hotLabel: '热度分',
        sub: [
          o.play_cnt ? `播放 ${fmtCount(o.play_cnt)}` : '',
          o.publish_time ? `${fmtDate(o.publish_time)} 发布` : '',
          o.nick_name ? `@${o.nick_name}` : '',
        ].filter(Boolean).join(' · '),
        cover: o.item_cover_url || null,
      }));
  },
  'douyin/search': async (query) => {
    // 视频搜索 V2：三个关键词各搜一遍后合并去重。
    // publish_time 只支持 1/7/180 天档位，先取能覆盖 from 的最小档位，
    // 再按 from/to 精确过滤 create_time，按累计点赞取前 20
    const days = query.from
      ? Math.ceil((Date.now() - new Date(query.from + 'T00:00:00').getTime()) / 86400000)
      : 1;
    const publishTime = days <= 1 ? '1' : days <= 7 ? '7' : '180';

    const searchOneKeyword = async (keyword) => {
      const collected = [];
      let cursor = 0, searchId = '', backtrace = '';
      for (let page = 0; page < 3; page++) {
        const data = await tikhub('/api/v1/douyin/search/fetch_video_search_v2', {
          keyword,
          cursor,
          sort_type: '1',
          publish_time: publishTime,
          filter_duration: '0',
          content_type: '0',
          search_id: searchId,
          backtrace,
        });
        for (const b of data?.business_data || []) {
          const aw = b?.data?.aweme_info;
          if (aw) collected.push(aw);
        }
        const bc = data?.business_config || {};
        if (!bc.has_more) break;
        cursor = Number(bc.next_page?.cursor) || cursor + 10;
        searchId = bc.next_page?.search_id || bc.next_page?.search_request_id || searchId;
        backtrace = bc.backtrace || '';
        if (collected.length >= 30) break;
      }
      return collected;
    };

    const merged = await fetchMergedByKeywords(searchOneKeyword, (aw) => aw.aweme_id);
    return merged
      .filter((aw) => inDateRange(aw.create_time, query.from, query.to))
      .sort((a, b) => (b.statistics?.digg_count || 0) - (a.statistics?.digg_count || 0))
      .slice(0, 50)
      .map((aw, i) => ({
        rank: i + 1,
        title: aw.desc || '(无标题)',
        hot: fmt(aw.statistics?.digg_count),
        hotLabel: '点赞',
        sub: [
          aw.statistics?.comment_count ? `评论 ${fmtCount(aw.statistics.comment_count)}` : '',
          aw.create_time ? `${fmtDate(aw.create_time)} 发布` : '',
          aw.author?.nickname ? `@${aw.author.nickname}` : '',
        ].filter(Boolean).join(' · '),
        cover: aw.video?.cover?.url_list?.[0] || null,
      }));
  },
  'douyin/highlike': async (query) => {
    // 高点赞率榜，三个关键词各过滤一遍后合并；date_window 仅支持 1(按小时统计口径)，传 2 会报参数不合法
    const objs = await fetchMergedByKeywords(
      (keyword) =>
        tikhub('/api/v1/douyin/billboard/fetch_hot_total_high_like_list', {
          page: 1,
          page_size: 50,
          date_window: 1,
          keyword,
          tags: [],
        }).then((data) => data?.data?.objs || []),
      (o) => o.item_id
    );
    return objs
      .filter((o) => inDateRange(o.publish_time, query.from, query.to))
      .sort((a, b) => (b.like_cnt || 0) - (a.like_cnt || 0))
      .slice(0, 50)
      .map((o, i) => ({
        rank: i + 1,
        title: o.item_title || '(无标题)',
        hot: fmt(o.like_cnt),
        hotLabel: '1小时点赞',
        sub: [
          o.play_cnt ? `1小时播放 ${fmtCount(o.play_cnt)}` : '',
          o.like_rate ? `点赞率 ${(o.like_rate * 100).toFixed(1)}%` : '',
          o.publish_time ? `${fmtDate(o.publish_time)} 发布` : '',
          o.nick_name ? `@${o.nick_name}` : '',
        ].filter(Boolean).join(' · '),
        cover: o.item_cover_url || null,
      }));
  },
  'kuaishou/manju': async (query) => {
    // 「AI漫剧」话题标签热门 feed，抽取剧集(serial)维度并按剧去重，按剧集总播放量排序
    const seen = new Map();
    let pcursor = '';
    for (let page = 0; page < 3; page++) {
      const qs = `general_tag_id=${encodeURIComponent('AI漫剧')}&tab=hot${pcursor ? `&pcursor=${encodeURIComponent(pcursor)}` : ''}`;
      const data = await tikhub(`/api/v1/kuaishou/app/fetch_tag_feed?${qs}`);
      for (const m of data?.mixFeeds || []) {
        const feed = m.feed || {};
        const serial = feed.standardSerial?.serial;
        if (!serial?.id) continue; // 无剧集信息的单条视频（二创/混剪）不进剧榜
        if (!inDateRange((feed.timestamp || 0) / 1000, query.from, query.to)) continue;
        const prev = seen.get(serial.id);
        if (!prev || (serial.viewCount || 0) > prev.hotRaw) {
          // 剧名为「合集1」这类占位名时，从视频标题的《书名号》里提取真实剧名
          let title = serial.title || '';
          if (!title || /^(动画)?合集\d*$/.test(title)) {
            title = (feed.caption || '').match(/《([^》]+)》/)?.[1] || title || feed.caption || '(无名)';
          }
          seen.set(serial.id, {
            title,
            hotRaw: serial.viewCount || 0,
            episodes: serial.episodeCount,
            author: feed.user_name,
            ts: feed.timestamp,
            cover: feed.cover_thumbnail_urls?.[0]?.url || null,
          });
        }
      }
      pcursor = data?.pcursor;
      if (!pcursor || pcursor === 'no_more') break;
    }
    return [...seen.values()]
      .sort((a, b) => b.hotRaw - a.hotRaw)
      .map((s, i) => ({
        rank: i + 1,
        title: s.title,
        hot: fmt(s.hotRaw),
        hotLabel: '剧集播放',
        sub: [
          s.episodes ? `${s.episodes}集` : '',
          s.ts ? `${fmtDate(s.ts / 1000)} 发布` : '',
          s.author ? `@${s.author}` : '',
        ].filter(Boolean).join(' · '),
        cover: s.cover,
      }));
  },
};

const cacheKeyOf = (key, query) => `${key}?from=${query.from || ''}&to=${query.to || ''}`;

const isDefaultQuery = (query) => {
  const today = localDateStr();
  return query.from === today && query.to === today;
};

async function fetchAndCache(key, query) {
  const items = await boards[key](query);
  const payload = { ok: true, updatedAt: new Date().toISOString(), count: items.length, items };
  cache.set(cacheKeyOf(key, query), { at: Date.now(), payload });
  return payload;
}

async function getBoard(key, query) {
  const hit = cache.get(cacheKeyOf(key, query));
  if (isDefaultQuery(query)) {
    // 默认时段：只读定时刷新的缓存；冷启动或跨天后缓存缺失时现场拉一次补上
    if (hit) return { ...hit.payload, cached: true };
    return fetchAndCache(key, query);
  }
  // 自定义时间段：按需拉取 + 60s 兜底缓存
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.payload, cached: true };
  }
  return fetchAndCache(key, query);
}

// ---- 定时刷新：每 2 小时把当天数据全量刷进缓存（快手已下线，不参与） ----
const AUTO_REFRESH_BOARDS = ['douyin/search', 'douyin/highlike', 'douyin/manju'];

async function refreshDefaultBoards() {
  const today = localDateStr();
  const query = { from: today, to: today };
  for (const key of AUTO_REFRESH_BOARDS) {
    try {
      const payload = await fetchAndCache(key, query);
      console.log(`[定时刷新] ${key} 完成，${payload.count} 条`);
    } catch (err) {
      // 失败保留上一轮缓存，下个周期再试
      console.error(`[定时刷新] ${key} 失败:`, err.message);
    }
  }
}

// ---- 静态文件服务 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const urlPath = u.pathname;
  const key = urlPath.replace(/^\/api\//, '');
  if (urlPath.startsWith('/api/') && boards[key]) {
    try {
      const query = { from: u.searchParams.get('from') || '', to: u.searchParams.get('to') || '' };
      // 未选时间时默认当天
      if (!query.from && !query.to) query.from = query.to = localDateStr();
      const payload = await getBoard(key, query);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
    }
    return;
  }
  await serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`[auto-fetch] 服务已启动 http://localhost:${PORT}`);
  refreshDefaultBoards();
  setInterval(refreshDefaultBoards, REFRESH_INTERVAL_MS);
});
