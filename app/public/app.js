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
let phoneDate = TODAY;
let editState = null;

// 拖拽状态。投放格是拖拽期间才盖上去的一层，静止态 DOM 与拖拽上线前完全一致
let drag = null;
let lastDropAt = 0;
let zoneLayer = null;   // 覆盖层容器：拖拽期间才存在
let zoneList = [];     // 覆盖层里的投放格，位置照原卡片算
let hotZone = null;     // 当前高亮的那一格
// 卡片 DOM → 安排对象：拖拽要认卡，但不往 DOM 里加属性（静止态要和服务端渲染的基线逐字一致）
const itemOf = new WeakMap();
// 拖拽起手时预取前后两周，翻周不必等跨境往返；一次即弃，写操作后清空
const weekAhead = new Map();

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

  // 拖拽翻页时用的是起手预取的那一份，翻过去立刻有内容
  const key = from + '|' + to;
  const ahead = weekAhead.get(key);
  if (ahead) {
    weekAhead.delete(key);
    items = ahead;
    return;
  }

  const boot = window.__WB_BOOT__;
  if (!bootUsed && boot && boot.from === from && boot.to === to) {
    bootUsed = true;
    const data = await withSignal(boot.data, signal);
    items = data.items || [];
    return;
  }

  const data = await api(`/api/items?from=${from}&to=${to}`, { signal });
  items = data.items || [];
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
  // 拖拽中的那张卡留在原位，只把墨褪掉 —— 摘走会带动整列重排，纸跟着长高
  if (drag && drag.item.id === item.id) card.classList.add('drag-src');

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
}

function renderWeek() {
  const week = $('week');
  week.textContent = '';
  const pool = items;
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
    stack.className = 'stack';
    list.forEach((it, k) => stack.appendChild(makeCard(it, siblingsOf, k)));

    if (!list.length) {
      const hint = document.createElement('p');
      hint.className = 'empty';
      hint.textContent = '空着';
      stack.appendChild(hint);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add';
    add.textContent = '＋';
    add.title = `在 ${monthDay(date)} 添加安排`;
    add.addEventListener('click', () => openEditor(key, null));
    stack.appendChild(add);

    day.appendChild(stack);
    week.appendChild(day);
  }
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

  const pool = items;
  const dayItems = pool.filter((it) => it.date === phoneDate).sort(D.compareArrangements);
  const siblingsOf = siblingsFn(pool);

  if (!dayItems.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '这天还没排';
    list.appendChild(empty);
  } else {
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
  // 翻周/翻天会重建卡片，投放格得照新位置重算
  if (drag && drag.active) buildZones();
}

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
  $('editor').showModal();
  fitEditor();
  setTimeout(() => { $('fTitle').focus(); fitEditor(); }, 40);
}

function closeEditor() {
  $('editor').close();
  editState = null;
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
   投放格是拖拽期间盖上去的一层，位置照原卡片算：列表不动，纸不长高，页不跳。
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
    const key = from + '|' + to;
    if (weekAhead.has(key)) continue;
    api(`/api/items?from=${from}&to=${to}`)
      .then((d) => { weekAhead.set(key, d.items || []); })
      .catch(() => {});
  }
}

/* 投放格按原卡片的位置算：有卡的时段占它自己那几张卡的上下沿，空段插在邻居之间。
   卡片不动，落点照样一眼可见。 */
function bandsFor(date, box, cardEls, out) {
  const boxRect = box.getBoundingClientRect();
  const left = boxRect.left + 2;
  const width = Math.max(24, boxRect.width - 4);
  const top = boxRect.top + 4;
  // 只剩一条安排时，三格会挤成一条缝；至少给每格一个指头的高度（不够就盖到纸外）
  const bottom = Math.max(boxRect.bottom - 4, Math.min(window.innerHeight - 8, top + 3 * 46));

  const filled = [];
  for (const s of D.SLOTS) {
    const cards = [...cardEls].filter((el) => { const it = itemOf.get(el); return it && it.slot === s; });
    if (!cards.length) continue;
    const a = cards[0].getBoundingClientRect();
    const b = cards[cards.length - 1].getBoundingClientRect();
    filled.push({ slot: s, i: D.SLOTS.indexOf(s), top: a.top - 2, bottom: b.bottom + 2 });
  }

  if (!filled.length) {
    const h = (bottom - top) / 3;
    D.SLOTS.forEach((s, i) => out.push({ date, slot: s, left, width, top: top + i * h, height: Math.max(24, h - 3) }));
    return;
  }

  // 连续的几个空时段凑成一组、把剩余空间均分；不然它们会全叠在同一段空隙里
  const GAP = 6;
  const at = new Map(filled.map((f) => [f.slot, f]));
  let cursor = top;
  let i = 0;
  while (i < D.SLOTS.length) {
    const hit = at.get(D.SLOTS[i]);
    if (hit) {
      out.push({ date, slot: D.SLOTS[i], left, width, top: hit.top, height: hit.bottom - hit.top });
      cursor = hit.bottom + GAP;
      i++;
      continue;
    }
    let j = i;
    while (j < D.SLOTS.length && !at.has(D.SLOTS[j])) j++;
    const next = j < D.SLOTS.length ? at.get(D.SLOTS[j]) : null;
    const gBottom = next ? next.top - 4 : bottom;
    const n = j - i;
    const span = Math.max(0, gBottom - cursor);
    // 命中区不小于 24px：手指落得住，比「不超出纸面」重要
    const h = Math.max(24, Math.min(44, (span - (n - 1) * GAP) / n));
    let t = cursor + Math.max(0, (span - (h * n + (n - 1) * GAP)) / 2);
    for (let k = i; k < j; k++) {
      out.push({ date, slot: D.SLOTS[k], left, width, top: t, height: h });
      t += h + GAP;
    }
    cursor = t;
    i = j;
  }
}

function buildZones() {
  clearZones();
  const bands = [];
  if (isNarrow()) {
    const list = $('pList');
    bandsFor(phoneDate, list, list.querySelectorAll('.card'), bands);
  } else {
    for (const day of $('week').querySelectorAll('.day')) {
      const stack = day.querySelector('.stack');
      bandsFor(day.dataset.date, stack, stack.querySelectorAll('.card'), bands);
    }
  }

  zoneLayer = document.createElement('div');
  zoneLayer.className = 'zone-layer';
  for (const b of bands) {
    const el = document.createElement('div');
    el.className = 'zone z-' + b.slot;
    el.dataset.date = b.date;
    el.dataset.slot = b.slot;
    el.style.left = b.left + 'px';
    el.style.top = b.top + 'px';
    el.style.width = b.width + 'px';
    el.style.height = b.height + 'px';
    const lab = document.createElement('span');
    lab.className = 'zone-lab';
    lab.textContent = D.SLOT_LABELS[b.slot];
    el.appendChild(lab);
    zoneLayer.appendChild(el);
    zoneList.push({ date: b.date, slot: b.slot, el, left: b.left, top: b.top, width: b.width, height: b.height });
  }
  document.body.appendChild(zoneLayer);
}

function clearZones() {
  if (zoneLayer) zoneLayer.remove();
  zoneLayer = null;
  zoneList = [];
  hotZone = null;
}

// 取包含手指的那一格；两格重叠时取离手指中心更近的一格
function zoneAt(x, y) {
  let best = null;
  let bestGap = Infinity;
  for (const z of zoneList) {
    if (x < z.left || x > z.left + z.width || y < z.top || y > z.top + z.height) continue;
    const gap = Math.abs(y - (z.top + z.height / 2));
    if (gap < bestGap) { bestGap = gap; best = z; }
  }
  return best;
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

/* 只判「落在哪」，不算位次：位次要量每张卡的矩形，放到 pointermove 里会一直触发重排。
   命中投放格时 zone 非空，松手那一下再按 y 算 index；落在周条上时 index 直接给出。 */
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

  const z = zoneAt(x, y);
  if (!z) return null;
  return { date: z.date, slot: z.slot, zone: z };
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

// 拖拽期间页面还是可能被滚走（滚轮、第二根手指），格子得跟着卡片重算
const refitZones = () => { if (drag && drag.active) buildZones(); };
window.addEventListener('scroll', refitZones, { passive: true });
window.addEventListener('resize', refitZones);

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

  drag.card.classList.add('drag-src');
  document.body.classList.add('dragging');
  prefetchWeeks();
  buildZones();
}

function endDrag() {
  if (drag && drag.ghost) drag.ghost.remove();
  if (drag) {
    clearTimeout(drag.timer);
    try { document.body.releasePointerCapture(drag.pointerId); } catch (_) {}
  }
  drag = null;
  clearZones();
  stopEdge();
  document.body.classList.remove('dragging');
  render();
}

function highlight(x, y) {
  const t = hitTest(x, y);
  const z = t ? t.zone : null;
  if (z === hotZone) return;
  if (hotZone) hotZone.el.classList.remove('on');
  if (z) z.el.classList.add('on');
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
  const next = addDays(parseYmd(phoneDate), n);
  phoneDate = ymd(next);
  const ws = startOfWeek(next);
  if (ymd(ws) !== ymd(weekStart)) weekStart = ws;
  renderHeader();
  renderStrip();
  refresh();
}

function goToday() {
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
  if (e.key === 'ArrowLeft') shiftWeek(-1);
  if (e.key === 'ArrowRight') shiftWeek(1);
});

renderSlotPicker();
refresh();
