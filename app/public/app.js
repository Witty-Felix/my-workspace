'use strict';

const SLOTS = ['am', 'pm', 'eve'];
const SLOT_LABEL = { am: '上午', pm: '下午', eve: '晚上' };
const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const $ = (id) => document.getElementById(id);
const p2 = (n) => String(n).padStart(2, '0');

function ymd(d) { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
function md(d) { return `${p2(d.getMonth() + 1)}.${p2(d.getDate())}`; }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
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
  return `${t.getFullYear()}-W${p2(w)}`;
}

const TODAY = ymd(new Date());

let cursor = startOfWeek(new Date());
let items = [];
let phoneDate = TODAY;
let editState = null;

/* ---------------- 网络 ---------------- */

async function api(path, opts) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

async function loadWeek() {
  const from = ymd(cursor);
  const to = ymd(addDays(cursor, 6));
  const data = await api(`/api/items?from=${from}&to=${to}`);
  items = data.items || [];
}

async function refresh() {
  try {
    await loadWeek();
    render();
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- 渲染 ---------------- */

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 220);
  }, 2600);
}

function bySort(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const sa = SLOTS.indexOf(a.slot);
  const sb = SLOTS.indexOf(b.slot);
  if (sa !== sb) return sa - sb;
  return a.order - b.order;
}

function makeCard(item, siblingsOf) {
  const card = document.createElement('article');
  card.className = 'card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${SLOT_LABEL[item.slot]} ${item.title}`);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const dot = document.createElement('i');
  dot.className = `sdot ${item.slot}`;
  meta.appendChild(dot);
  meta.appendChild(document.createTextNode(SLOT_LABEL[item.slot]));

  const acts = document.createElement('div');
  acts.className = 'acts';
  const sibs = siblingsOf(item);
  const idx = sibs.findIndex((x) => x.id === item.id);

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

function siblingsFn(list) {
  return (item) => list
    .filter((x) => x.date === item.date && x.slot === item.slot)
    .sort((a, b) => a.order - b.order);
}

function render() {
  renderHeader();
  renderWeek();
  renderPhone();
}

function renderHeader() {
  const isThis = ymd(cursor) === ymd(startOfWeek(new Date()));
  $('wkKey').textContent = isoWeek(cursor);
  $('wkRange').textContent = `${md(cursor)} – ${md(addDays(cursor, 6))}`;
  $('todayBtn').classList.toggle('on', isThis);
}

function renderWeek() {
  const week = $('week');
  week.textContent = '';
  const siblingsOf = siblingsFn(items);

  for (let i = 0; i < 7; i++) {
    const date = addDays(cursor, i);
    const key = ymd(date);
    const day = document.createElement('div');
    day.className = 'day' + (key === TODAY ? ' today' : '');
    day.dataset.date = key;

    const head = document.createElement('div');
    head.className = 'day-head';
    const dow = document.createElement('span');
    dow.className = 'dow';
    dow.textContent = DOW[i];
    const dnum = document.createElement('span');
    dnum.className = 'dnum';
    dnum.textContent = md(date);
    head.append(dow, dnum);
    day.appendChild(head);

    const rail = document.createElement('div');
    rail.className = 'rail';
    rail.appendChild(Object.assign(document.createElement('i'), { className: 'dot' }));
    day.appendChild(rail);

    const stack = document.createElement('div');
    stack.className = 'stack';

    const list = items.filter((it) => it.date === key).sort(bySort);
    for (const it of list) stack.appendChild(makeCard(it, siblingsOf));

    if (!list.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = '空';
      stack.appendChild(hint);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add';
    add.textContent = '＋';
    add.title = `在 ${md(date)} 添加安排`;
    add.addEventListener('click', () => openEditor(key, null));
    stack.appendChild(add);

    day.appendChild(stack);
    week.appendChild(day);
  }
}

function renderPhone() {
  const d = parseYmd(phoneDate);
  const inThisWeek = phoneDate >= ymd(cursor) && phoneDate <= ymd(addDays(cursor, 6));
  $('pDay').textContent = `${DOW[(d.getDay() + 6) % 7]} · ${md(d)}${inThisWeek ? '' : ''}`;

  const list = $('pList');
  list.textContent = '';

  const dayItems = items.filter((it) => it.date === phoneDate).sort(bySort);
  if (!dayItems.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint on';
    empty.textContent = '这天还没有安排';
    list.appendChild(empty);
  } else {
    let lastSlot = null;
    const siblingsOf = siblingsFn(items);
    for (const it of dayItems) {
      if (it.slot !== lastSlot) {
        const h = document.createElement('div');
        h.className = 'slot-head';
        h.textContent = SLOT_LABEL[it.slot];
        list.appendChild(h);
        lastSlot = it.slot;
      }
      list.appendChild(makeCard(it, siblingsOf));
    }
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn ghost wide';
  add.textContent = '＋ 添加安排';
  add.addEventListener('click', () => openEditor(phoneDate, null));
  list.appendChild(add);
}

/* ---------------- 交互 ---------------- */

function defaultSlot() {
  const h = new Date().getHours();
  if (h < 12) return 'am';
  if (h < 18) return 'pm';
  return 'eve';
}

function openEditor(date, item) {
  editState = { date, item };
  const d = parseYmd(date);
  $('edDate').textContent = `${DOW[(d.getDay() + 6) % 7]} · ${md(d)}`;
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
    $('err').textContent = '标题不能为空';
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

function shiftWeek(n) {
  cursor = addDays(cursor, n * 7);
  const start = ymd(cursor);
  if (phoneDate < start || phoneDate > ymd(addDays(cursor, 6))) phoneDate = start;
  refresh();
}

$('prev').addEventListener('click', () => shiftWeek(-1));
$('next').addEventListener('click', () => shiftWeek(1));
$('wkBtn').addEventListener('click', goToday);
$('todayBtn').addEventListener('click', goToday);

function goToday() {
  cursor = startOfWeek(new Date());
  phoneDate = TODAY;
  refresh();
}

$('pPrev').addEventListener('click', () => { phoneDate = ymd(addDays(parseYmd(phoneDate), -1)); syncCursorToPhone(); render(); });
$('pNext').addEventListener('click', () => { phoneDate = ymd(addDays(parseYmd(phoneDate), 1)); syncCursorToPhone(); render(); });

function syncCursorToPhone() {
  const start = ymd(cursor);
  const end = ymd(addDays(cursor, 6));
  if (phoneDate < start || phoneDate > end) {
    cursor = startOfWeek(parseYmd(phoneDate));
    refresh();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if ($('editor').open) return;
  if (e.key === 'ArrowLeft') shiftWeek(-1);
  if (e.key === 'ArrowRight') shiftWeek(1);
});

refresh();
