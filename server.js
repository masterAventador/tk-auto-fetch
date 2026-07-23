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

// ---- 服务端缓存：同一榜单 60s 内复用，避免浏览器高频轮询/多人访问重复计费 ----
const CACHE_TTL_MS = 60 * 1000;
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
    if (json.code !== 200) throw new Error(`TikHub code=${json.code} ${json.message || ''}`);
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

const fmtDate = (ts) => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---- 榜单抓取 + 归一化，统一输出 { rank, title, hot, sub, cover }，query 里可带 from/to ----
const boards = {
  'douyin/manju': async (query) => {
    // 抖音热点视频总榜（小时级窗口）+ keyword=漫剧 过滤，即 AI 漫剧热度榜
    const data = await tikhub('/api/v1/douyin/billboard/fetch_hot_total_video_list', {
      page: 1,
      page_size: 50,
      date_window: 1,
      sub_type: 1001,
      keyword: '漫剧',
      tags: [],
    });
    const objs = data?.data?.objs || [];
    return objs
      .filter((o) => inDateRange(o.publish_time, query.from, query.to))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((o, i) => ({
        rank: i + 1,
        title: o.item_title || '(无标题)',
        hot: fmt(o.score),
        hotLabel: '热度分',
        sub: [
          o.play_cnt ? `播放 ${o.play_cnt >= 1e4 ? (o.play_cnt / 1e4).toFixed(1) + '万' : o.play_cnt}` : '',
          o.publish_time ? `${fmtDate(o.publish_time)} 发布` : '',
          o.nick_name ? `@${o.nick_name}` : '',
        ].filter(Boolean).join(' · '),
        cover: o.item_cover_url || null,
      }));
  },
  'douyin/series': async (query) => {
    const data = await tikhub('/api/v1/douyin/web/fetch_series_aweme?offset=0&count=30&content_type=0');
    return (data.card_list || [])
      .filter((c) => inDateRange(c.series?.create_time, query.from, query.to))
      .map((c, i) => {
      const s = c.series || {};
      return {
        rank: i + 1,
        title: s.series_name || '(无名)',
        hot: fmt(s.stats?.play_vv),
        hotLabel: '播放量',
        sub: [s.status?.status_desc, s.create_time ? `${fmtDate(s.create_time)} 上线` : '', s.author?.nickname].filter(Boolean).join(' · '),
        cover: s.cover_url?.url_list?.[0] || null,
      };
    });
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
  'douyin/hotsearch': async () => {
    const data = await tikhub('/api/v1/douyin/app/v3/fetch_hot_search_list');
    const list = data?.data?.word_list || [];
    return list.map((w, i) => ({
      rank: i + 1,
      title: w.word || '',
      hot: fmt(w.hot_value),
      hotLabel: '热度',
      sub: w.view_count ? `${w.view_count} 次浏览` : '',
      cover: null,
    }));
  },
};

async function getBoard(key, query) {
  const cacheKey = `${key}?from=${query.from || ''}&to=${query.to || ''}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.payload, cached: true };
  }
  const items = await boards[key](query);
  const payload = { ok: true, updatedAt: new Date().toISOString(), count: items.length, items };
  cache.set(cacheKey, { at: Date.now(), payload });
  return payload;
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
});
