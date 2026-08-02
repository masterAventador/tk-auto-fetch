// 快手暂时下线，恢复时加回 'kuaishou/manju'
const ACTIVE_BOARDS = ['douyin/search', 'douyin/highlike', 'douyin/manju'];

// 各榜数据口径说明，展示在列表顶部
const BOARD_DESC = {
  'douyin/search':
    '数据来源：抖音分别搜索「动态漫」「AI漫剧」「漫剧」三个关键词，结果合并去重。筛选当天发布的视频，按【累计总点赞】从高到低排列。注意：抖音对带时间筛选的搜索只开放很少量结果，本榜条数可能偏少，属于抖音侧的供给限制。',
  'douyin/highlike':
    '数据来源：抖音官方「高点赞率榜」中匹配「动态漫 / AI漫剧 / 漫剧」的视频（合并去重），收录近 1 小时内 点赞÷播放 转化率高的视频，擅长发现播放不大但观众反馈特别好的内容。右侧数字是【近 1 小时新增点赞】（不是累计总点赞），已按其从高到低排列。',
  'douyin/manju':
    '数据来源：抖音官方「视频热榜」中匹配「动态漫 / AI漫剧 / 漫剧」的视频（合并去重，小时级统计）。右侧【热度分】由官方综合播放、点赞、评论、转发、增速等多项权重计算，不等于点赞量。',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function panelEl(board) {
  return $(`.panel[data-board="${board}"]`);
}

function fmtHot(n) {
  if (n == null) return '';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderRows(items) {
  return items
    .map((it) => {
      const cover = it.cover
        ? `<img class="cover" src="${it.cover}" referrerpolicy="no-referrer" onerror="this.style.display='none'" />`
        : '';
      const hot = it.hot != null ? `<div class="hot">${fmtHot(it.hot)}<small>${it.hotLabel || ''}</small></div>` : '';
      const meta = it.sub ? `<div class="meta">${it.sub}</div>` : '';
      return `<div class="row">
        <div class="rank ${it.rank <= 3 ? 'top' : ''}">${it.rank}</div>
        ${cover}
        <div class="info"><div class="title">${escapeHtml(it.title)}</div>${meta}</div>
        ${hot}
      </div>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function dateQuery() {
  const qs = new URLSearchParams();
  const from = $('#dateFrom').value;
  const to = $('#dateTo').value;
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const s = qs.toString();
  return s ? '?' + s : '';
}

// 各榜最近一次渲染的数据版本（服务端 updatedAt），静默轮询时版本没变就跳过重绘
const lastUpdatedAt = {};

// silent=true 为后台静默轮询：不展示 loading，失败不打扰界面，数据版本未变不重绘
async function loadBoard(board, { silent = false } = {}) {
  const el = panelEl(board);
  if (!el) return;
  if (!silent && !el.innerHTML.trim()) el.innerHTML = `<div class="loading"><span class="spin"></span> 加载中…</div>`;
  try {
    const res = await fetch('/api/' + board + dateQuery());
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '接口返回异常');
    if (silent && lastUpdatedAt[board] === data.updatedAt) return;
    lastUpdatedAt[board] = data.updatedAt;
    const desc = BOARD_DESC[board] ? `<div class="board-desc">${BOARD_DESC[board]}</div>` : '';
    el.innerHTML =
      desc +
      `<div class="status"><span>共 ${data.count} 条</span><span>更新于 ${fmtTime(data.updatedAt)}</span></div>` +
      renderRows(data.items);
  } catch (err) {
    if (silent) return;
    el.innerHTML = `<div class="error">加载失败：${escapeHtml(err.message)}<br /><small>可点击「立即刷新」重试</small></div>`;
  }
}

// 只加载当前可见 tab 的榜单；其余 tab 首次切换时再加载，减少 TikHub 计费请求
function visibleBoards() {
  return ACTIVE_BOARDS.filter((b) => {
    const el = panelEl(b);
    return el && !el.classList.contains('hidden');
  });
}

// 日期变化 / 手动刷新：清空全部面板缓存内容，重新加载可见榜单
function reloadAll() {
  ACTIVE_BOARDS.forEach((b) => {
    const el = panelEl(b);
    if (el) el.innerHTML = '';
  });
  visibleBoards().forEach((b) => loadBoard(b));
}

function setupTabs() {
  $$('.platform').forEach((section) => {
    $$('.tab', section).forEach((tab) => {
      tab.addEventListener('click', () => {
        const board = tab.dataset.board;
        $$('.tab', section).forEach((t) => t.classList.toggle('active', t === tab));
        $$('.panel', section).forEach((p) => p.classList.toggle('hidden', p.dataset.board !== board));
        const panel = panelEl(board);
        if (panel && !panel.innerHTML.trim()) loadBoard(board);
        else loadBoard(board, { silent: true });
      });
    });
  });
}

function setupPlatformSwitch() {
  const grid = $('.grid');
  $$('.pf-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.pf-tab').forEach((t) => t.classList.toggle('active', t === tab));
      grid.dataset.activePf = tab.dataset.pf;
    });
  });
}

// 前端轮询间隔。服务端每 2 小时刷新缓存，前端高频轮询只读缓存（无 TikHub 成本），
// 靠 updatedAt 判断数据是否变化，服务端刷新后前端最多滞后 1 分钟跟上
const AUTO_REFRESH_MS = 60 * 1000;

// 是否为默认「当天」时段；自定义时间段会穿透服务端缓存打 TikHub，不参与自动轮询
function isDefaultDateRange() {
  return $('#dateFrom').value === todayStr() && $('#dateTo').value === todayStr();
}

document.addEventListener('DOMContentLoaded', () => {
  // 日期默认当天
  $('#dateFrom').value = todayStr();
  $('#dateTo').value = todayStr();
  setupTabs();
  setupPlatformSwitch();
  $('#refreshAll').addEventListener('click', reloadAll);
  ['#dateFrom', '#dateTo'].forEach((sel) => $(sel).addEventListener('change', reloadAll));
  visibleBoards().forEach((b) => loadBoard(b));
  setInterval(() => {
    if (!isDefaultDateRange()) return;
    visibleBoards().forEach((b) => loadBoard(b, { silent: true }));
  }, AUTO_REFRESH_MS);
});
