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

async function loadWeek() {
  const from = ymd(weekStart);
  const to = ymd(addDays(weekStart, 6));
  const data = await api(`/api/items?from=${from}&to=${to}`);
  items = data.items || [];
}

async function refresh(retryLeft = 1) {
  try {
    await loadWeek();
    render();
  } catch (err) {
    // 4xx 是参数/权限问题，重试没用；网络错误与 5xx 才重试一次
    if (retryLeft > 0 && (!err.status || err.status >= 500)) {
      setTimeout(() => refresh(retryLeft - 1), 600);
      return;
    }
    toast(err.message);
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
  card.className = 'card ' + item.slot;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${D.SLOT_LABELS[item.slot]} ${item.title}`);
  card.style.setProperty('--tilt', (idxForTilt % 2 ? .35 : -.3) + 'deg');

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

  const open = () => openEditor(item.date, item);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });

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
  const siblingsOf = siblingsFn(items);

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const key = ymd(date);
    const day = document.createElement('div');
    day.className = 'day' + (key === TODAY ? ' today' : '');
    day.dataset.date = key;

    const list = items.filter((it) => it.date === key).sort(D.compareArrangements);

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
  const dayItems = items.filter((it) => it.date === phoneDate).sort(D.compareArrangements);

  if (!dayItems.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '这天还没排';
    list.appendChild(empty);
  } else {
    let lastSlot = null;
    const siblingsOf = siblingsFn(items);
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
  setTimeout(() => $('fTitle').focus(), 40);
}

function closeEditor() {
  $('editor').close();
  editState = null;
}

async function move(item, dir) {
  try {
    await api(`/api/items/${item.id}/move`, { method: 'POST', body: JSON.stringify({ dir }) });
    await refresh();
  } catch (err) {
    toast(err.message);
  }
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

/* ---------------- 导航 ---------------- */

// 翻周时停在同一个星期几上，手机端不会跳回周一
function shiftWeek(n) {
  const idx = Math.round((parseYmd(phoneDate) - weekStart) / 86400000);
  weekStart = addDays(weekStart, n * 7);
  phoneDate = ymd(addDays(weekStart, Math.min(6, Math.max(0, idx))));
  refresh();
}

function goToday() {
  weekStart = startOfWeek(new Date());
  phoneDate = TODAY;
  refresh();
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
  if (e.key === 'ArrowLeft') shiftWeek(-1);
  if (e.key === 'ArrowRight') shiftWeek(1);
});

renderSlotPicker();
refresh();
