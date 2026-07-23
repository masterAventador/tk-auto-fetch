const ACTIVE_BOARDS = ['douyin/manju', 'douyin/series', 'douyin/hotsearch', 'kuaishou/hotboard'];
// 支持发布时间过滤的榜单（热搜/快手热榜无历史维度，不受日期影响）
const DATE_FILTER_BOARDS = new Set(['douyin/manju', 'douyin/series']);
let timer = null;

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

function dateQuery(board) {
  if (!DATE_FILTER_BOARDS.has(board)) return '';
  const from = $('#dateFrom').value;
  const to = $('#dateTo').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const s = qs.toString();
  return s ? '?' + s : '';
}

async function loadBoard(board) {
  const el = panelEl(board);
  if (!el) return;
  if (!el.innerHTML.trim()) el.innerHTML = `<div class="loading"><span class="spin"></span> 加载中…</div>`;
  try {
    const res = await fetch('/api/' + board + dateQuery(board));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '接口返回异常');
    el.innerHTML =
      `<div class="status"><span>共 ${data.count} 条</span><span>更新于 ${fmtTime(data.updatedAt)}${data.cached ? ' (缓存)' : ''}</span></div>` +
      renderRows(data.items);
  } catch (err) {
    el.innerHTML = `<div class="error">加载失败：${escapeHtml(err.message)}<br /><small>稍后将自动重试</small></div>`;
  }
}

function loadAll() {
  ACTIVE_BOARDS.forEach(loadBoard);
}

function setupTabs() {
  $$('.platform').forEach((section) => {
    $$('.tab', section).forEach((tab) => {
      tab.addEventListener('click', () => {
        const board = tab.dataset.board;
        $$('.tab', section).forEach((t) => t.classList.toggle('active', t === tab));
        $$('.panel', section).forEach((p) => p.classList.toggle('hidden', p.dataset.board !== board));
      });
    });
  });
}

function setupTimer() {
  const sel = $('#interval');
  const restart = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(loadAll, Number(sel.value));
  };
  sel.addEventListener('change', restart);
  restart();
}

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupTimer();
  $('#refreshAll').addEventListener('click', loadAll);
  ['#dateFrom', '#dateTo'].forEach((sel) =>
    $(sel).addEventListener('change', () => DATE_FILTER_BOARDS.forEach(loadBoard))
  );
  loadAll();
});
