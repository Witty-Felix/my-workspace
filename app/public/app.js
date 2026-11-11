'use strict';

/* 周工作台：数据走 /api/items，界面是纸 + 墨 + 硬投影。
   渲染分两套容器 —— 桌面是整周那张纸（七列），手机是当天那张纸。 */

const D = window.WBDomain;   // 领域常量与排序规则，与服务端共用同一份（domain.js）
if (!D) throw new Error('domain.js 没加载到，时段常量缺失');
const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');

const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthDay = (d) => `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const week1 = new Date(t.getFullYear(), 0, 4);
  const w = 1 + Math.round(((t - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${t.getFullYear()}-W${pad2(w)}`;
}

const TODAY = ymd(new Date());

let weekStart = startOfWeek(new Date());
let items = [];
// 当前这一周的规划条目（见 GLOSSARY.md 的「周规划」）。与 items 分开存，不参与落位
let plan = [];
let phoneDate = TODAY;
let editState = null;

/* 规划窗的界面状态。位置用视口坐标，拖过就记住；不落盘，刷新回默认位 */
const planUi = {
  open: false,
  pinned: false,
  min: false,
  x: null,
  y: null,
  w: 372,
  h: 348,
  drag: null,
  rz: null,
  editId: null,
};
let planEl = null;
// 正在编辑的那一条的提交函数：切换目标、拖动、翻周之前先落地，否则改动会丢
let planCommit = null;
function flushPlanEdit() {
  const f = planCommit;
  planCommit = null;
  if (f) f();
}

// 拖拽状态。投放格是拖拽期间才存在的一组流内方框（.zone），静止态没有它们
let drag = null;
let lastDropAt = 0;
let hotZone = null;    // 当前高亮的那一格
// 卡片 DOM → 安排对象：拖拽要认卡，但不往 DOM 里加属性（静止态要和服务端渲染的基线逐字一致）
const itemOf = new WeakMap();
// 拖拽起手时预取前后两周，翻周不必等跨境往返；一次即弃，写操作后清空
const weekAhead = new Map();
// 预取时顺带带回的周规划，与 weekAhead 同键同寿命
const aheadPlan = new Map();

/* ---------------- 网络 ---------------- */

async function api(path, opts) {
  // 用相对路径：既能直连 :8090 的根路径，也能挂在 /workbench/ 子路径下
  const url = path.replace(/^\//, '');
  const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;   // 让调用方能判断该不该重试
    throw err;
  }
  return res.json();
}

// 首屏那次请求：index.html 的内联脚本在 HTML 解析时就发了，这里直接捡现成的
let bootUsed = false;

// 把一个 promise 绑到 AbortSignal 上：signal 触发时一起 reject
function withSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

async function loadWeek(signal) {
  const from = ymd(weekStart);
  const to = ymd(addDays(weekStart, 6));
  const wk = isoWeek(weekStart);

  // 拖拽翻页时用的是起手预取的那一份，翻过去立刻有内容
  const key = from + '|' + to;
  const ahead = weekAhead.get(key);
  if (ahead) {
    weekAhead.delete(key);
    items = ahead;
    plan = aheadPlan.get(key) || [];
    return;
  }

  const boot = window.__WB_BOOT__;
  if (!bootUsed && boot && boot.from === from && boot.to === to) {
    bootUsed = true;
    const data = await withSignal(boot.data, signal);
    items = data.items || [];
    plan = data.plan || [];
    return;
  }
  // 周规划跟着这一趟顺路回来（week 显式传，不靠 from 是不是周一）
  const data = await api(`/api/items?from=${from}&to=${to}&week=${wk}`, { signal });
  items = data.items || [];
  plan = data.plan || [];
}

// 同一时刻只留一个列表请求：连点翻周时，后发的会把先发的取消掉，
// 免得几个响应回来后互相覆盖、界面来回跳
let inflight = null;

async function refresh(retryLeft = 1) {
  if (inflight) { try { inflight.abort(); } catch (_) {} }
  const ctrl = new AbortController();
  inflight = ctrl;
  try {
    await loadWeek(ctrl.signal);
    if (inflight !== ctrl) return;
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;   // 被更新的请求顶掉了，静默
    // 4xx 是参数/权限问题，重试没用；网络错误与 5xx 才重试一次
    if (retryLeft > 0 && (!err.status || err.status >= 500)) {
      setTimeout(() => refresh(retryLeft - 1), 600);
      return;
    }
    toast(err.message);
  } finally {
    if (inflight === ctrl) inflight = null;
  }
}

/* ---------------- 主题 ---------------- */

const media = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'day';
  $('themeSwitch').checked = dark;
  // 颜色只有一个真相源：style.css 的 --paper，换配色不用动这里
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  if (paper) $('metaTheme').setAttribute('content', paper);
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('wb-theme'); } catch (_) {}
  applyTheme(saved ? saved === 'dark' : media.matches);
})();

$('themeSwitch').addEventListener('change', (e) => {
  const dark = e.target.checked;
  applyTheme(dark);
  try { localStorage.setItem('wb-theme', dark ? 'dark' : 'day'); } catch (_) {}
});

/* ---------------- 通用 ---------------- */

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 220);
  }, 2400);
}

// 同一时段的安排排在一起，组内按 order 先后
function siblingsFn(list) {
  return (item) => list
    .filter((x) => D.groupKey(x) === D.groupKey(item))
    .sort(D.byOrder);
}

/* 时段选择：三个选项从 domain.js 生成，标签不再在 HTML 里写死 */
function renderSlotPicker() {
  const seg = $('seg');
  for (const id of D.SLOTS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'slot';
    input.value = id;
    const span = document.createElement('span');
    span.textContent = D.SLOT_LABELS[id];
    label.append(input, span);
    seg.appendChild(label);
  }
}

/* ---------------- 渲染 ---------------- */

function makeCard(item, siblingsOf, idxForTilt = 0) {
  const card = document.createElement('article');
  card.className = 'card ' + item.slot + (item.doneAt ? ' done' : '');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${D.SLOT_LABELS[item.slot]} ${item.title}${item.doneAt ? '（已完成）' : ''}`);
  card.style.setProperty('--tilt', (idxForTilt % 2 ? .35 : -.3) + 'deg');

  // 常驻的完成勾：常显（触屏没有 hover），点它只改完成状态，不碰排序与落位
  const tick = document.createElement('button');
  tick.type = 'button';
  tick.className = 'tick';
  tick.title = item.doneAt ? '取消完成' : '标记完成';
  tick.setAttribute('aria-label', item.doneAt ? '取消完成' : '标记完成');
  tick.addEventListener('click', (e) => { e.stopPropagation(); setDone(item, !item.doneAt); });
  card.appendChild(tick);

  const sibs = siblingsOf(item);
  const idx = sibs.findIndex((x) => x.id === item.id);

  // 一个时段里只有一条时没有可挪的，排序钮不出现
  if (sibs.length > 1) {
    const acts = document.createElement('div');
    acts.className = 'acts';

    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '↑';
    up.title = '上移';
    up.disabled = idx <= 0;
    up.addEventListener('click', (e) => { e.stopPropagation(); move(item, 'up'); });

    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '↓';
    down.title = '下移';
    down.disabled = idx < 0 || idx >= sibs.length - 1;
    down.addEventListener('click', (e) => { e.stopPropagation(); move(item, 'down'); });

    acts.append(up, down);
    card.appendChild(acts);
  } else {
    card.classList.add('solo');
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const dot = document.createElement('i');
  dot.className = 'sdot';
  meta.append(dot, document.createTextNode(D.SLOT_LABELS[item.slot]));
  card.appendChild(meta);

  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = item.title;
  card.appendChild(title);

  if (item.note) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = item.note;
    card.appendChild(note);
  }

  const open = () => {
    // 拖拽松手后的那一次 click 不该顺带打开编辑框
    if (Date.now() - lastDropAt < 260) return;
    openEditor(item.date, item);
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    // 勾和排序钮自己处理键盘；冒泡上来的 Enter 不该顺带打开编辑框
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });

  itemOf.set(card, item);
  return card;
}

function renderHeader() {
  const isThis = ymd(weekStart) === ymd(startOfWeek(new Date()));
  $('wkKey').textContent = isoWeek(weekStart);
  $('wkRange').textContent = `${monthDay(weekStart)} – ${monthDay(addDays(weekStart, 6))}`;
  $('todayBtn').classList.toggle('on', isThis);
  $('planBtn').classList.toggle('on', planUi.open);
  $('planBtn').setAttribute('aria-pressed', String(planUi.open));
}

function renderWeek() {
  const week = $('week');
  week.textContent = '';
  // 拖拽中：被拖的那张卡只以跟手影子存在，列表里绝不渲染（否则就是残影）
  const pool = (drag && drag.active) ? items.filter((x) => x.id !== drag.item.id) : items;
  const siblingsOf = siblingsFn(pool);

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const key = ymd(date);
    const day = document.createElement('div');
    day.className = 'day' + (key === TODAY ? ' today' : '');
    day.dataset.date = key;

    const list = pool.filter((it) => it.date === key).sort(D.compareArrangements);

    const head = document.createElement('div');
    head.className = 'day-head';
    const dow = document.createElement('span');
    dow.className = 'dow';
    dow.textContent = DOW[i];
    const dnum = document.createElement('span');
    dnum.className = 'dnum';
    dnum.textContent = monthDay(date);
    head.append(dow, dnum);
    if (list.length) {
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = list.length;
      head.appendChild(cnt);
    }
    day.appendChild(head);

    const stack = document.createElement('div');
    stack.className = 'stack' + (drag && drag.active ? ' dropping' : '');

    if (drag && drag.active) {
      // 拖拽态：每天铺开上午/下午/晚上三个流内方框，卡片住自己时段的框，空档也留位
      for (const slot of D.SLOTS) {
        stack.appendChild(zoneEl(key, slot, list.filter((it) => it.slot === slot), siblingsOf));
      }
      // 整列没有安排时，三格均分撑满列高 —— 否则纸面下半截留一片死白
      if (!list.length) stack.classList.add('all-empty');
    } else {
      list.forEach((it, k) => stack.appendChild(makeCard(it, siblingsOf, k)));

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'add';
      add.textContent = '＋';
      add.title = `在 ${monthDay(date)} 添加安排`;
      add.addEventListener('click', () => openEditor(key, null));
      stack.appendChild(add);
    }

    day.appendChild(stack);
    week.appendChild(day);
  }
}

// 拖拽态的流内方框：一个时段一个框，卡片住框里
function zoneEl(date, slot, list, siblingsOf) {
  const z = document.createElement('div');
  z.className = 'zone z-' + slot;
  z.dataset.date = date;
  z.dataset.slot = slot;

  const lab = document.createElement('span');
  lab.className = 'zone-lab';
  lab.textContent = D.SLOT_LABELS[slot];
  z.appendChild(lab);

  // 空白时段加高 0.5 倍：这格没有安排，纯粹是落点，要比卡片格更好丢
  if (!list.length) z.classList.add('empty');

  list.forEach((it) => z.appendChild(makeCard(it, siblingsOf)));
  return z;
}

function renderPhone() {
  const d = parseYmd(phoneDate);

  const head = $('pDay');
  head.textContent = '';
  head.append(DOW[(d.getDay() + 6) % 7]);
  const sm = document.createElement('small');
  sm.textContent = monthDay(d);
  head.appendChild(sm);

  // 翻到别周时才给「回今天」，本周内不占位置
  if (ymd(weekStart) !== ymd(startOfWeek(new Date()))) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back';
    back.textContent = '回今天';
    back.addEventListener('click', goToday);
    head.appendChild(back);
  }

  renderStrip();

  const list = $('pList');
  list.textContent = '';
  list.className = 'phone-list' + (drag && drag.active ? ' dropping' : '');

  // 拖拽中：被拖的那张卡只以跟手影子存在，列表里绝不渲染
  const pool = (drag && drag.active) ? items.filter((x) => x.id !== drag.item.id) : items;
  const dayItems = pool.filter((it) => it.date === phoneDate).sort(D.compareArrangements);
  const siblingsOf = siblingsFn(pool);

  if (drag && drag.active) {
    for (const slot of D.SLOTS) {
      list.appendChild(zoneEl(phoneDate, slot, dayItems.filter((it) => it.slot === slot), siblingsOf));
    }
    // 和桌面同一条规则：当天没有安排时三格均分撑满，不留死白
    list.classList.toggle('all-empty', !dayItems.length);
    return;
  }
  list.classList.remove('all-empty');

  let lastSlot = null;
  for (const it of dayItems) {
    if (it.slot !== lastSlot) {
      const h = document.createElement('div');
      h.className = 'slot-head';
      h.dataset.slot = it.slot;
      h.textContent = D.SLOT_LABELS[it.slot];
      list.appendChild(h);
      lastSlot = it.slot;
    }
    list.appendChild(makeCard(it, siblingsOf));
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn wide';
  add.textContent = '＋ 添加安排';
  add.addEventListener('click', () => openEditor(phoneDate, null));
  list.appendChild(add);
}

/* 周条：7 天一字排开，点哪天看哪天；两侧箭头翻周 */
function renderStrip() {
  const strip = $('pStrip');
  strip.textContent = '';
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const key = ymd(date);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip'
      + (key === phoneDate ? ' on' : '')
      + (key === TODAY ? ' today' : '');
    chip.setAttribute('aria-label', `${DOW[i]} ${monthDay(date)}`);
    if (key === phoneDate) chip.setAttribute('aria-current', 'date');

    const dowShort = document.createElement('span');
    dowShort.textContent = DOW[i].slice(1);
    const num = document.createElement('b');
    num.textContent = pad2(date.getDate());
    chip.append(dowShort, num);

    chip.addEventListener('click', () => { phoneDate = key; render(); });
    strip.appendChild(chip);
  }
}

function render() {
  renderHeader();
  renderWeek();
  renderPhone();
  renderPlanWin();
  // 翻周/翻天重建列表后，之前高亮的格子节点已不存在
  if (drag && drag.active) clearHotZone();
}

/* ---------------- 周规划 ----------------
   一个可以拖动的浮窗：一周一份条目，勾选即完成，点行就地改标题与备注。
   与「安排」完全分开 —— 不落位、不占时段、不进周轴。

   静止态 DOM 与上线前一致：窗口只在打开时渲染，默认不打开。
   位置只记在内存里，刷新回默认位（同拖拽态三格的处理方式）。 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PLAN_ICONS = {
  pin: 'M6 2.2h4M8 2.2v4.6l2.4 2.4H5.6L8 6.8V2.2M8 9.2v4.6',
  min: 'M3.4 8h9.2',
  close: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6',
  check: 'M3 8.4l3.3 3.3L13 5',
  plus: 'M8 3.2v9.6M3.2 8h9.6',
  trash: 'M4 4.6h8M6.6 4.6V3.2h2.8v1.4M5.2 4.6l.6 8.2h4.4l.6-8.2',
};

function planIcon(name, cls) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', PLAN_ICONS[name]);
  s.appendChild(p);
  return s;
}

// 窗口标题跟着翻到的那一周走，不看「今天」
function planTitle() {
  const thisWeek = ymd(weekStart) === ymd(startOfWeek(new Date()));
  if (thisWeek) return '本周规划';
  const diff = Math.round((weekStart - startOfWeek(new Date())) / 86400000);
  if (diff === 7) return '下周规划';
  if (diff === -7) return '上周规划';
  return isoWeek(weekStart) + ' 规划';
}

function renderPlanWin() {
  if (planEl) { planEl.remove(); planEl = null; }
  if (!planUi.open) return;

  const done = plan.filter((p) => p.doneAt).length;

  const el = document.createElement('section');
  el.className = 'pw' + (planUi.pinned ? ' pinned' : '') + (planUi.min ? ' min' : '');
  el.style.width = planUi.w + 'px';
  if (!planUi.min) el.style.height = planUi.h + 'px';

  /* --- 标题栏：拖动把手 --- */
  const bar = document.createElement('div');
  bar.className = 'pw-bar';

  const t = document.createElement('span');
  t.className = 't';
  t.textContent = planTitle();

  const n = document.createElement('span');
  n.className = 'n';
  n.textContent = plan.length ? `${done}/${plan.length}` : '空';

  const saved = document.createElement('span');
  saved.className = 'saved';
  saved.textContent = '已保存';

  const sp = document.createElement('span');
  sp.className = 'sp';

  bar.append(t, n, saved, sp);

  const mkBtn = (icon, tip, on, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pw-btn' + (on ? ' on' : '');
    b.title = tip;
    b.setAttribute('aria-label', tip);
    if (on) b.setAttribute('aria-pressed', 'true');
    b.appendChild(planIcon(icon));
    b.addEventListener('click', fn);
    return b;
  };

  bar.append(
    mkBtn('pin', planUi.pinned ? '取消置顶（点外面会收起）' : '置顶：点别处也不被遮盖', planUi.pinned, () => {
      planUi.pinned = !planUi.pinned;
      renderPlanWin();
    }),
    mkBtn('min', planUi.min ? '展开' : '最小化，只留标题栏', false, () => {
      flushPlanEdit();
      planUi.min = !planUi.min;
      renderPlanWin();
    }),
    mkBtn('close', '收起（内容已存）', false, () => {
      flushPlanEdit();
      planUi.open = false;
      renderPlanWin();
      renderHeader();
    })
  );

  el.appendChild(bar);

  /* --- 列表 --- */
  const list = document.createElement('div');
  list.className = 'pw-list';

  if (!plan.length) {
    const e = document.createElement('p');
    e.className = 'pw-empty';
    e.textContent = '这一周还没写。加一条开始。';
    list.appendChild(e);
  } else {
    plan.forEach((p) => list.appendChild(planRowEl(p)));
  }
  el.appendChild(list);

  /* --- 添加 --- */
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'pw-add';
  add.appendChild(planIcon('plus', 'sm'));
  add.appendChild(document.createTextNode('添加一条'));
  add.addEventListener('click', addPlanRow);
  el.appendChild(add);

  /* --- 缩放把手 --- */
  const rz = document.createElement('div');
  rz.className = 'pw-resize';
  rz.title = '拖这里改大小';
  el.appendChild(rz);

  planDragify(el, bar);
  planResizify(el, rz);
  placePlanWin(el);
  document.body.appendChild(el);
  planEl = el;
}

function placePlanWin(el) {
  if (planUi.x === null) {
    const narrow = window.innerWidth <= 900;
    planUi.w = narrow ? Math.min(360, window.innerWidth - 20) : 372;
    planUi.x = narrow ? 10 : Math.max(12, window.innerWidth - planUi.w - 34);
    planUi.y = narrow ? 64 : 92;
  }
  el.style.left = planUi.x + 'px';
  el.style.top = planUi.y + 'px';
}

function planRowEl(p) {
  const wrap = document.createElement('div');
  wrap.className = 'pw-row' + (p.doneAt ? ' done' : '');
  wrap.dataset.id = p.id;

  /* 勾：只改完成状态，不打开编辑、不碰顺序 */
  const chk = document.createElement('button');
  chk.type = 'button';
  chk.className = 'pw-chk';
  chk.setAttribute('aria-pressed', String(!!p.doneAt));
  chk.setAttribute('aria-label', p.doneAt ? '取消完成' : '标记完成');
  chk.title = p.doneAt ? '取消完成' : '标记完成';
  const ring = document.createElement('i');
  ring.appendChild(planIcon('check'));
  chk.appendChild(ring);
  chk.addEventListener('click', (e) => {
    e.stopPropagation();
    setPlanDone(p, !p.doneAt);
  });
  wrap.appendChild(chk);

  /* 内容槽：只读与编辑轮流住在里面，行节点本身不换 */
  const content = document.createElement('div');
  content.className = 'pw-content';
  wrap.appendChild(content);

  /* 删除：悬停显形，触屏常显 */
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'pw-del';
  del.title = '删除这一条';
  del.setAttribute('aria-label', '删除这一条');
  del.appendChild(planIcon('trash', 'sm'));
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    delPlanRow(p);
  });
  wrap.appendChild(del);

  /* 点行进编辑：pointerdown 里就落地，别等 click 被 blur 吃掉 */
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pw-chk,.pw-del')) return;
    if (planUi.editId === p.id) return;
    flushPlanEdit();
    planUi.editId = p.id;
    fillPlanRow(wrap, content, p);
  });

  fillPlanRow(wrap, content, p);
  return wrap;
}

function fillPlanRow(wrap, content, p) {
  content.textContent = '';
  if (planUi.editId === p.id) {
    content.appendChild(planEditorEl(p, wrap, content));
    return;
  }

  const rc = document.createElement('div');
  rc.className = 'pw-rc';
  const t = document.createElement('p');
  t.className = 'pw-rt';
  t.textContent = p.title || '未命名';
  rc.appendChild(t);
  // 没有备注就不渲染占位：那一行的高度让给内容，不铺空白
  if (p.note) {
    const nt = document.createElement('p');
    nt.className = 'pw-rn';
    nt.textContent = p.note;
    rc.appendChild(nt);
  }
  content.appendChild(rc);
}

/* 就地编辑：标题 + 备注同住一块编辑区。
   提交时机是「焦点离开整块编辑区」而不是单个输入失焦 ——
   否则从标题点向备注时，标题先 blur 就重绘，备注框当场被销毁，点不进去。 */
function planEditorEl(p, wrap, content) {
  const box = document.createElement('div');
  box.className = 'pw-edit';

  const t = document.createElement('input');
  t.className = 't';
  t.value = p.title;
  t.maxLength = 80;
  t.placeholder = '这一条要做什么？';

  const n = document.createElement('input');
  n.className = 'n';
  n.value = p.note || '';
  n.maxLength = 200;
  n.placeholder = '备注（可选）';

  box.append(t, n);

  let closed = false;
  const leave = (save) => {
    if (closed) return;
    closed = true;
    if (planCommit === commit) planCommit = null;

    const title = t.value.trim().slice(0, 80);
    const note = n.value.trim().slice(0, 200);

    if (!save) {
      // 放弃：新增的空条目直接消失，已有条目保持原样
      planUi.editId = null;
      if (!p.title && !p.note) {
        const i = plan.indexOf(p);
        if (i >= 0) plan.splice(i, 1);
        wrap.remove();
      } else {
        fillPlanRow(wrap, content, p);
      }
      syncPlanBar();
      return;
    }

    // 标题和备注都空：这条等于没写
    if (!title && !note) {
      planUi.editId = null;
      const i = plan.indexOf(p);
      if (i >= 0) plan.splice(i, 1);
      wrap.remove();
      if (!p.id.startsWith('tmp-')) delPlanRow(p, true);
      syncPlanBar();
      return;
    }

    // 只有备注没有标题：服务端要求标题必填，界面上不能让它变成一次失败的写入。
    // 这一条留着不存，回到只读并把提示写进备注位，用户补个标题就能存
    if (!title) {
      planUi.editId = null;
      p.title = '';
      p.note = note;
      fillPlanRow(wrap, content, p);
      const hint = wrap.querySelector('.pw-rt');
      if (hint) {
        hint.textContent = '先写个标题';
        hint.classList.add('need-title');
      }
      syncPlanBar();
      return;
    }

    const changed = title !== p.title || note !== (p.note || '');
    p.title = title;
    if (note) p.note = note; else delete p.note;
    planUi.editId = null;
    fillPlanRow(wrap, content, p);
    syncPlanBar();
    if (changed) savePlanRow(p, true);
  };
  const commit = () => leave(true);

  planCommit = commit;

  // 焦点在编辑区内部移动（标题 ↔ 备注）不算离开
  box.addEventListener('focusout', (e) => {
    if (box.contains(e.relatedTarget)) return;
    leave(true);
  });

  for (const el of [t, n]) {
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); leave(true); }
      if (e.key === 'Escape') { e.preventDefault(); leave(false); }
      if (e.key === 'ArrowDown' && el === t) { e.preventDefault(); n.focus(); }
      if (e.key === 'ArrowUp' && el === n) { e.preventDefault(); t.focus(); }
    });
    el.addEventListener('click', (e) => e.stopPropagation());
  }

  // 光标落在末尾，不选中全文：改备注时不想整段被替换
  setTimeout(() => {
    t.focus();
    const len = t.value.length;
    try { t.setSelectionRange(len, len); } catch (_) {}
  }, 20);

  return box;
}

function syncPlanBar() {
  if (!planEl) return;
  const done = plan.filter((p) => p.doneAt).length;
  const n = planEl.querySelector('.pw-bar .n');
  if (n) n.textContent = plan.length ? `${done}/${plan.length}` : '空';
}

function flashPlanSaved() {
  if (!planEl) return;
  const s = planEl.querySelector('.pw-bar .saved');
  if (!s) return;
  s.classList.add('on');
  clearTimeout(flashPlanSaved.timer);
  flashPlanSaved.timer = setTimeout(() => s.classList.remove('on'), 1100);
}

/* ---- 规划的写操作：都走同一条写队列，与服务端串行对齐 ---- */

function setPlanDone(p, done) {
  if (done) p.doneAt = new Date().toISOString();
  else delete p.doneAt;

  // 只改这一行的外观：整窗重画会把节点换掉，正在进行的点击会落在死节点上
  if (planEl) {
    const row = planEl.querySelector(`.pw-row[data-id="${p.id}"]`);
    if (row) {
      row.classList.toggle('done', !!p.doneAt);
      const chk = row.querySelector('.pw-chk');
      if (chk) {
        chk.setAttribute('aria-pressed', String(!!p.doneAt));
        chk.setAttribute('aria-label', p.doneAt ? '取消完成' : '标记完成');
        chk.title = p.doneAt ? '取消完成' : '标记完成';
      }
    }
  }
  syncPlanBar();

  enqueueWrite(async () => {
    if (p.id.startsWith('tmp-')) return;   // 还没落盘的新条目，等它建完自己带上状态
    await api(`/api/plan/${p.id}`, { method: 'PATCH', body: JSON.stringify({ done }) });
    weekAhead.clear();
    aheadPlan.clear();
  });
}

function savePlanRow(p, flash) {
  // 没有标题就不发请求：服务端会 400，界面会白刷一次
  if (!p.title) return;

  const body = { title: p.title, note: p.note || '' };

  enqueueWrite(async () => {
    if (p.id.startsWith('tmp-')) {
      // 新建：先 POST 拿到真 id，再把占位对象换成服务端返回的那一条。
      // 建的时候若已经勾过，把完成状态一并带上，否则刷新后勾就丢了
      const r = await api('/api/plan', {
        method: 'POST',
        body: JSON.stringify({
          week: isoWeek(weekStart),
          title: p.title,
          note: p.note || '',
          done: !!p.doneAt,
        }),
      });
      const i = plan.indexOf(p);
      if (i >= 0) plan[i] = r.plan;
      renderPlanWin();
      return;
    }
    await api(`/api/plan/${p.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    weekAhead.clear();
    aheadPlan.clear();
    if (flash) flashPlanSaved();
  });
}

function addPlanRow() {
  flushPlanEdit();
  const p = { id: 'tmp-' + Date.now().toString(36), week: isoWeek(weekStart), title: '', order: plan.length };
  plan.push(p);
  planUi.editId = p.id;
  planUi.min = false;
  renderPlanWin();
}

function delPlanRow(p, quiet) {
  const i = plan.indexOf(p);
  if (i >= 0) plan.splice(i, 1);
  if (planUi.editId === p.id) planUi.editId = null;
  if (!quiet) renderPlanWin();
  if (p.id.startsWith('tmp-')) { syncPlanBar(); return; }

  enqueueWrite(async () => {
    await api(`/api/plan/${p.id}`, { method: 'DELETE' });
    weekAhead.clear();
    aheadPlan.clear();
  });
}

/* ---- 拖动与缩放 ---- */

function planDragify(el, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 拿起标题栏就先退出编辑：正在改的内容按失焦规则保存。
    // 这一句必须在「排除按钮」之前 —— 点标题栏上的图钉/最小化/关闭，
    // 也该先落地正在编辑的那一条，否则按钮自己的 renderPlanWin 会把它销毁
    flushPlanEdit();
    if (e.target.closest('button')) return;
    const r = el.getBoundingClientRect();
    planUi.drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    el.classList.add('dragging');
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    const d = planUi.drag;
    if (!d || e.pointerId !== d.id) return;
    planUi.x = Math.max(6, Math.min(e.clientX - d.dx, window.innerWidth - el.offsetWidth - 6));
    planUi.y = Math.max(6, Math.min(e.clientY - d.dy, window.innerHeight - el.offsetHeight - 6));
    el.style.left = planUi.x + 'px';
    el.style.top = planUi.y + 'px';
  });

  const end = (e) => {
    const d = planUi.drag;
    if (!d || e.pointerId !== d.id) return;
    planUi.drag = null;
    el.classList.remove('dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function planResizify(el, rz) {
  rz.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = el.getBoundingClientRect();
    planUi.rz = { id: e.pointerId, w: r.width, h: r.height, x0: e.clientX, y0: e.clientY };
    try { rz.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    e.stopPropagation();
  });
  rz.addEventListener('pointermove', (e) => {
    const d = planUi.rz;
    if (!d || e.pointerId !== d.id) return;
    planUi.w = Math.max(268, Math.min(window.innerWidth - planUi.x - 8, d.w + (e.clientX - d.x0)));
    planUi.h = Math.max(180, Math.min(window.innerHeight - planUi.y - 8, d.h + (e.clientY - d.y0)));
    el.style.width = planUi.w + 'px';
    el.style.height = planUi.h + 'px';
  });
  const end = (e) => {
    if (!planUi.rz || e.pointerId !== planUi.rz.id) return;
    planUi.rz = null;
    try { rz.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  rz.addEventListener('pointerup', end);
  rz.addEventListener('pointercancel', end);
}

/* ---- 开合：顶栏按钮 / 点外面 / Esc ---- */

/* 安排弹框进 top layer 时规划窗让位；关掉弹框再回来。
   记的是「之前开着没有」，所以没开过就不会被无端弹出来 */
let planSuspended = false;

function suspendPlanWin() {
  if (!planUi.open) return;
  flushPlanEdit();
  planSuspended = true;
  planUi.open = false;
  renderPlanWin();
  renderHeader();
}

function resumePlanWin() {
  if (!planSuspended) return;
  planSuspended = false;
  planUi.open = true;
  renderPlanWin();
  renderHeader();
}

function togglePlanWin() {
  flushPlanEdit();
  planUi.open = !planUi.open;
  if (planUi.open) planUi.min = false;
  renderPlanWin();
  renderHeader();
}

$('planBtn').addEventListener('click', togglePlanWin);

// 未置顶时点外面收起；置顶后点别处既不沉也不关
document.addEventListener('pointerdown', (e) => {
  if (!planUi.open || planUi.pinned) return;
  // 顶栏（翻周、回本周、规划按钮）不算「外面」：翻周时窗口该跟着换内容，而不是被关掉
  if (e.target.closest('.pw, .bar')) return;
  if (planUi.editId) return;
  planUi.open = false;
  renderPlanWin();
  renderHeader();
}, true);

window.addEventListener('resize', () => {
  if (!planUi.open || planUi.x === null) return;
  planUi.x = Math.max(6, Math.min(planUi.x, window.innerWidth - 300));
  planUi.y = Math.max(6, Math.min(planUi.y, window.innerHeight - 180));
  renderPlanWin();
});

/* ---------------- 编辑 ---------------- */

function defaultSlot() {
  return D.slotForHour(new Date().getHours());
}

function openEditor(date, item) {
  editState = { date, item };
  const d = parseYmd(date);

  const head = $('edDate');
  head.textContent = '';
  head.append(DOW[(d.getDay() + 6) % 7]);
  const sm = document.createElement('span');
  sm.textContent = monthDay(d);
  head.appendChild(sm);

  $('fTitle').value = item ? item.title : '';
  $('fNote').value = item ? (item.note || '') : '';
  const slot = item ? item.slot : defaultSlot();
  const radio = document.querySelector(`input[name="slot"][value="${slot}"]`);
  if (radio) radio.checked = true;
  $('delBtn').hidden = !item;
  $('err').hidden = true;
  // <dialog> 的 showModal 会进原生 top layer，任何 z-index 都压不过它。
  // 所以「置顶」遇到编辑安排时只能让位：先收掉规划窗，关掉弹框再恢复
  suspendPlanWin();
  $('editor').showModal();
  fitEditor();
  setTimeout(() => { $('fTitle').focus(); fitEditor(); }, 40);
}

function closeEditor() {
  $('editor').close();
  editState = null;
  resumePlanWin();
}

/* 键盘弹起时布局视口不变（dvh 也不变），CSS 居中会把框底留在键盘底下。
   改按 visualViewport 摆：算「看得见的那块」的中心，框就一直在键盘上方。 */
function fitEditor() {
  const ed = $('editor');
  if (!ed.open) return;
  const vv = window.visualViewport;
  const w = vv ? vv.width : window.innerWidth;
  const h = vv ? vv.height : window.innerHeight;
  const x = vv ? vv.offsetLeft : 0;
  const y = vv ? vv.offsetTop : 0;
  ed.style.left = (x + w / 2) + 'px';
  ed.style.top = (y + h / 2) + 'px';
  ed.style.maxHeight = Math.max(160, h - 24) + 'px';
}

if (window.visualViewport) {
  visualViewport.addEventListener('resize', fitEditor);
  visualViewport.addEventListener('scroll', fitEditor);
}
window.addEventListener('resize', fitEditor);

async function move(item, dir) {
  setBusy(true);
  try {
    await api(`/api/items/${item.id}/move`, { method: 'POST', body: JSON.stringify({ dir }) });
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

// 写操作共用一个队列：落位和完成改的是同一份数据，串行发送才能保证
// 后一次是照前一次改完的结果算的。失败统一 toast + 以服务端为准回滚。
let writeQueue = Promise.resolve();
function enqueueWrite(task) {
  writeQueue = writeQueue.then(async () => {
    try {
      await task();
    } catch (err) {
      toast(err.message);
      await refresh();
    }
  });
}

// 完成：先改界面再写服务端，失败以服务端为准回滚（同拖拽落位的原则）
function setDone(item, done) {
  if (done) item.doneAt = new Date().toISOString();
  else delete item.doneAt;
  render();

  enqueueWrite(async () => {
    await api(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ done }) });
    weekAhead.clear();   // 预取的前后两周里，这张卡的完成状态已经旧了
  });
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editState) return;
  const title = $('fTitle').value.trim();
  const note = $('fNote').value.trim();
  const slotEl = document.querySelector('input[name="slot"]:checked');
  const slot = slotEl ? slotEl.value : 'am';

  if (!title) {
    $('err').textContent = '写点什么再保存';
    $('err').hidden = false;
    $('fTitle').focus();
    return;
  }

  const btn = e.submitter || document.querySelector('#form .primary');
  if (btn) btn.disabled = true;
  setBusy(true);
  try {
    if (editState.item) {
      await api(`/api/items/${editState.item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title, note, slot }),
      });
    } else {
      await api('/api/items', {
        method: 'POST',
        body: JSON.stringify({ date: editState.date, slot, title, note }),
      });
    }
    closeEditor();
    await refresh();
  } catch (err) {
    $('err').textContent = err.message;
    $('err').hidden = false;
  } finally {
    if (btn) btn.disabled = false;
    setBusy(false);
  }
});

$('cancelBtn').addEventListener('click', closeEditor);

$('delBtn').addEventListener('click', async () => {
  if (!editState || !editState.item) return;
  if (!confirm('删除这条安排？')) return;
  try {
    await api(`/api/items/${editState.item.id}`, { method: 'DELETE' });
    closeEditor();
    await refresh();
  } catch (err) {
    $('err').textContent = err.message;
    $('err').hidden = false;
  }
});

$('editor').addEventListener('click', (e) => {
  if (e.target === $('editor')) closeEditor();
});

/* ---------------- 拖拽落位 ----------------
   Pointer Events 一套走鼠标、触屏、触控笔。落点决定时段，没有「非法落点」。
   拖拽态渲染流内三格（.zone）：每天列铺开上午/下午/晚上三个方框，卡片住自己
   时段的框，空档也留位；桌面把纸拉高、手机把当天列表撑满视口，格子不挤。
   触屏安全：拿起瞬间把原卡摘出列表、挂到 body 直属的固定锚点（视觉全隐）——
   touch 序列绑定在原卡节点上，列表怎么重建它都活着，翻页/翻天不再 pointercancel。
   松手先改界面再写服务端：跨境一来一回一两秒，等确认再动就像卡死。 */

const FLIP_FIRST = 600;    // 贴边多久翻第一页
const FLIP_REPEAT = 800;   // 之后每页的间隔，恒定不加速
const HOLD_MS = 250;       // 触屏按住多久算「拿起」
const HOLD_SLOP = 10;      // 待命期间允许的抖动，超了就当用户在滑页面

let edgeTimer = 0;
let edgeDir = 0;

const isNarrow = () => window.matchMedia('(max-width:900px)').matches;

// 落位走同一个写队列：后一次的 index 是照前一次改完后的本地状态算的，
// 乱序到达会让服务端的顺序和眼前看到的不一致。
function sendPlace(id, date, slot, index) {
  enqueueWrite(async () => {
    await api(`/api/items/${id}/place`, {
      method: 'POST',
      body: JSON.stringify({ date, slot, index }),
    });
    weekAhead.clear();
  });
}

// 拖拽起手就把前后两周取回来，翻页时不用等网络
function prefetchWeeks() {
  for (const n of [-1, 1]) {
    const from = ymd(addDays(weekStart, n * 7));
    const to = ymd(addDays(weekStart, n * 7 + 6));
    const wk = isoWeek(addDays(weekStart, n * 7));
    const key = from + '|' + to;
    if (weekAhead.has(key)) continue;
    api(`/api/items?from=${from}&to=${to}&week=${wk}`)
      .then((d) => {
        weekAhead.set(key, d.items || []);
        aheadPlan.set(key, d.plan || []);
      })
      .catch(() => {});
  }
}

function clearHotZone() {
  if (hotZone) { hotZone.classList.remove('on'); hotZone = null; }
}

// 落在某张卡上半＝插它前面，下半＝插它后面；只数同一天同一时段的卡
function indexIn(date, slot, y) {
  // 只看当前视图：另一套容器是 display:none，量出来的矩形全是 0
  const scope = isNarrow() ? $('pList') : $('week');
  let n = 0;
  for (const el of scope.querySelectorAll('.card')) {
    const it = itemOf.get(el);
    if (!it || it.id === drag.item.id || it.date !== date || it.slot !== slot) continue;
    const r = el.getBoundingClientRect();
    if (y > r.top + r.height / 2) n++;
  }
  return n;
}

/* 只判「落在哪」，不算位次：位次交给 indexIn 在松手时算。
   流内三格直接用 elementFromPoint 命中 .zone；落在周条上时 index 直接给出。 */
function hitTest(x, y) {
  if (!drag) return null;
  const el = document.elementFromPoint(x, y);

  // 手机：直接把卡丢到周条某天，时段不变，排到那天该段末尾
  const chip = el && el.closest('.chip');
  if (chip) {
    const i = Array.prototype.indexOf.call($('pStrip').children, chip);
    if (i >= 0) {
      const date = ymd(addDays(weekStart, i));
      const slot = drag.item.slot;
      const n = items.filter((it) => it.date === date && it.slot === slot && it.id !== drag.item.id).length;
      return { date, slot, index: n, zone: null };
    }
  }

  const z = el && el.closest('.zone');
  if (!z) return null;
  return { date: z.dataset.date, slot: z.dataset.slot, zone: z };
}

document.addEventListener('pointerdown', (e) => {
  if (drag) return;   // 一次只认一根手指，第二根不打断已经在拖的那张
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const card = e.target.closest('.card');
  if (!card || e.target.closest('.acts, .tick')) return;
  const item = itemOf.get(card);
  if (!item) return;

  drag = {
    item, card, pointerId: e.pointerId,
    x0: e.clientX, y0: e.clientY,
    active: false,
    armed: e.pointerType !== 'touch',
    ghost: null, offsetX: 0, offsetY: 0,
    timer: 0,
  };
  // 触屏要按住才拿起，否则一点就开始拖，列表滚不动
  if (e.pointerType === 'touch') {
    drag.timer = setTimeout(() => { if (drag) drag.armed = true; }, HOLD_MS);
  }
});

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;

  if (!drag.active) {
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.armed) {
      // 还没拿起就滑开了：这是滚动，把这次按压整个放掉
      if (Math.hypot(dx, dy) > HOLD_SLOP) { clearTimeout(drag.timer); drag = null; }
      return;
    }
    if (Math.hypot(dx, dy) < 4) return;
    startDrag();
  }

  if (drag.ghost) {
    drag.ghost.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
  }
  highlight(e.clientX, e.clientY);
  checkEdge(e.clientX);
}, { passive: true });

// 拿起之后由这里接管：第一次移动就挡掉浏览器滚动，触屏才拖得动
document.addEventListener('touchmove', (e) => {
  if (drag && (drag.active || drag.armed)) e.preventDefault();
}, { passive: false });

document.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  clearTimeout(drag.timer);
  if (!drag.active) { drag = null; return; }

  const t = hitTest(e.clientX, e.clientY);
  if (t) {
    const index = t.zone ? indexIn(t.date, t.slot, e.clientY) : t.index;
    D.placeItem(items, drag.item.id, t.date, t.slot, index);
    sendPlace(drag.item.id, t.date, t.slot, index);
  } else if (edgeAt(e.clientX)) {
    toast('边缘只翻页，不落位');
  }

  lastDropAt = Date.now();
  endDrag();
});

document.addEventListener('pointercancel', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (drag.active) { lastDropAt = Date.now(); endDrag(); }
  else { clearTimeout(drag.timer); drag = null; }
});

document.addEventListener('pointerleave', () => { if (drag && drag.active) stopEdge(); });
window.addEventListener('blur', stopEdge);

// 拖拽期间页面还是可能被滚走（滚轮、第二根手指）——流内三格随文档流走，无需重算
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drag && drag.active) endDrag();
});

function startDrag() {
  const rect = drag.card.getBoundingClientRect();
  drag.active = true;
  drag.offsetX = drag.x0 - rect.left;
  drag.offsetY = drag.y0 - rect.top;

  // 触屏指针默认捕获在这张卡上：卡一被重建，捕获就没了、接着来的是 pointercancel。
  // 改捕到 body，翻周重建卡片也照常跟手。
  try { document.body.setPointerCapture(drag.pointerId); } catch (_) {}

  const g = drag.card.cloneNode(true);
  for (const n of g.querySelectorAll('.acts, .tick')) n.remove();
  g.className = drag.card.className + ' drag-ghost';
  g.style.left = rect.left + 'px';
  g.style.top = rect.top + 'px';
  g.style.width = rect.width + 'px';
  document.body.appendChild(g);
  drag.ghost = g;

  // 原卡摘离列表，挂到 body 直属的固定锚点（视觉全隐）。
  // touch 序列绑定在原卡节点上：列表随翻页重建时它若还在列表里就会被销毁，
  // 浏览器随即 pointercancel（真机实测）。脱离列表后翻页/翻天随便重建。
  // 流内三格的格子自身恒定占位，无需额外占位符。
  const anchor = document.createElement('div');
  anchor.className = 'drag-anchor';
  document.body.appendChild(anchor);
  anchor.appendChild(drag.card);
  drag.anchor = anchor;

  document.body.classList.add('dragging');
  // 手机：拖拽态当天列表撑满视口，空天也有三格大框
  if (isNarrow()) document.querySelector('.phone-paper')?.classList.add('stretch');
  prefetchWeeks();
  render();
}

function endDrag() {
  if (drag && drag.ghost) drag.ghost.remove();
  if (drag && drag.anchor) drag.anchor.remove();
  if (drag) {
    clearTimeout(drag.timer);
    try { document.body.releasePointerCapture(drag.pointerId); } catch (_) {}
  }
  drag = null;
  clearHotZone();
  stopEdge();
  document.body.classList.remove('dragging');
  document.querySelector('.phone-paper')?.classList.remove('stretch');
  render();
}

function highlight(x, y) {
  const t = hitTest(x, y);
  const z = t ? t.zone : null;
  if (z === hotZone) return;
  if (hotZone) hotZone.classList.remove('on');
  if (z) z.classList.add('on');
  hotZone = z;
}

function edgeAt(x) {
  const edge = isNarrow() ? 34 : 12;   // 桌面再宽就会压到第一列卡片的左边
  return x < edge ? -1 : x > window.innerWidth - edge ? 1 : 0;
}

// 贴边不放就按固定节拍翻页；离开边缘立即停拍，重新贴边从头计
function checkEdge(x) {
  const d = edgeAt(x);
  if (d === edgeDir) return;
  stopEdge();
  if (!d) return;
  edgeDir = d;
  scheduleEdge(FLIP_FIRST);
}

function stopEdge() {
  clearTimeout(edgeTimer);
  edgeDir = 0;
}

function scheduleEdge(delay) {
  edgeTimer = setTimeout(tickEdge, delay);
}

function tickEdge() {
  if (!drag || !drag.active || !edgeDir) return;
  if (isNarrow()) shiftDay(edgeDir); else shiftWeek(edgeDir, true);
  flashPage();
  scheduleEdge(FLIP_REPEAT);
}

function flashPage() {
  const el = isNarrow() ? $('pDay') : $('wkKey');
  el.classList.remove('flip');
  void el.offsetWidth;
  el.classList.add('flip');
}

/* ---------------- 导航 ---------------- */

// 等待中的可视反馈：顶部一条进度线 + 内容区压暗。
// 跨境链路上一个往返可能一两秒，没有这层反馈用户只会觉得「点了没反应」。
let busyCount = 0;
function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  document.body.classList.toggle('busy', busyCount > 0);
}

// 翻周时停在同一个星期几上，手机端不会跳回周一
function shiftWeek(n, quiet) {
  flushPlanEdit();   // 翻走之前把正在改的那条落地，否则新一周的数据回来会盖掉它
  const idx = Math.round((parseYmd(phoneDate) - weekStart) / 86400000);
  weekStart = addDays(weekStart, n * 7);
  phoneDate = ymd(addDays(weekStart, Math.min(6, Math.max(0, idx))));
  // 乐观更新：周区间与日期条先换掉，内容等数据回来再补
  renderHeader();
  renderStrip();
  // 拖拽中不能走忙碌态：那层会把 stage 的指针事件关掉，落点判定全废
  if (quiet) { refresh(); return; }
  setBusy(true);
  refresh().finally(() => setBusy(false));
}

function shiftDay(n) {
  flushPlanEdit();
  const next = addDays(parseYmd(phoneDate), n);
  phoneDate = ymd(next);
  const ws = startOfWeek(next);
  if (ymd(ws) !== ymd(weekStart)) weekStart = ws;
  renderHeader();
  renderStrip();
  refresh();
}

function goToday() {
  flushPlanEdit();
  weekStart = startOfWeek(new Date());
  phoneDate = TODAY;
  renderHeader();
  renderStrip();
  setBusy(true);
  refresh().finally(() => setBusy(false));
}

$('prev').addEventListener('click', () => shiftWeek(-1));
$('next').addEventListener('click', () => shiftWeek(1));
$('wkBtn').addEventListener('click', goToday);
$('todayBtn').addEventListener('click', goToday);

$('pPrevW').addEventListener('click', () => shiftWeek(-1));
$('pNextW').addEventListener('click', () => shiftWeek(1));

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if ($('editor').open) return;
  if (drag) return;
  // 规划窗开着时方向键留给它：Esc 收起，左右键不翻周
  if (planUi.open) {
    if (e.key === 'Escape' && !planUi.editId) {
      planUi.open = false;
      renderPlanWin();
      renderHeader();
    }
    return;
  }
  if (e.key === 'ArrowLeft') shiftWeek(-1);
  if (e.key === 'ArrowRight') shiftWeek(1);
});

renderSlotPicker();
refresh();
