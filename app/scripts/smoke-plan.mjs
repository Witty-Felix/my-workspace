/* 周规划端到端自检：真浏览器、真服务、真接口。
   只测「看起来没事、其实会坏」的路径：
     1. 顶栏按钮开合，关掉内容不丢
     2. 新增一条 → 落盘 → 刷新后还在
     3. 勾选完成 → 划掉 → 刷新后仍是完成
     4. 点行就地改标题与备注 → 失焦保存 → 刷新后仍在
     5. 从标题点进备注不被中断（编辑区整体失焦才提交）
     6. 置顶后点别处不收起；未置顶点外面收起
     7. 一周一份：翻到别周看不到这周的条目
   跑法：npm run smoke:plan
*/
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser, touchFor } from './lib/cdp.mjs';
import { layoutCheck, reportLayout } from './lib/layout-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const WORK = path.join(APP, '.plan-smoke');
const DATA = path.join(WORK, 'data');
const PROFILE = path.join(WORK, 'profile');
const PORT = 8193;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmrf = (p) => { for (let i = 0; i < 5; i++) { try { fs.rmSync(p, { recursive: true, force: true }); return; } catch (_) {} } };

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

const BROWSER = findBrowser();
if (!BROWSER) { console.error('没找到浏览器'); process.exit(2); }
if (typeof WebSocket !== 'function') { console.error(`需要 Node 22+（内置 WebSocket），当前 ${process.version}`); process.exit(2); }

rmrf(WORK);
fs.mkdirSync(DATA, { recursive: true });
// 空库：规划要自己长出来，不能靠夹具蒙混
fs.writeFileSync(path.join(DATA, 'data.json'), JSON.stringify({ version: 1, items: [] }), 'utf8');

const server = spawn(process.execPath, ['server.js'], {
  cwd: APP,
  env: { ...process.env, PORT: String(PORT), AUTH: 'off', DATA_DIR: DATA },
  stdio: 'ignore',
});
const chrome = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=0',
  `--user-data-dir=${PROFILE}`,
  '--window-size=1440,900',
  `${BASE}/`,
], { stdio: 'ignore' });

let ws = null;
const stop = async () => {
  try { ws?.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  try { server.kill(); } catch (_) {}
  await sleep(600);
  rmrf(WORK);
};

let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch (_) {}
  await sleep(200);
}
if (!up) { await stop(); console.error('服务没起来'); process.exit(2); }

let dbg = 0;
for (let i = 0; i < 60; i++) {
  const f = path.join(PROFILE, 'DevToolsActivePort');
  if (fs.existsSync(f)) { dbg = Number(fs.readFileSync(f, 'utf8').split('\n')[0]); if (dbg) break; }
  await sleep(200);
}
if (!dbg) { await stop(); console.error('浏览器没开调试端口'); process.exit(2); }

let target = null;
for (let i = 0; i < 40; i++) {
  const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
  target = list.find((t) => t.type === 'page' && t.url.includes(`:${PORT}`));
  if (target) break;
  await sleep(200);
}
if (!target) { await stop(); console.error('拿不到页面'); process.exit(2); }

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
});

const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
});

const rectOf = (expr) => js(`(() => {
  const el = ${expr};
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

const clickEl = async (expr) => {
  const p = await rectOf(expr);
  if (!p) return false;
  await mouse('mousePressed', p.x, p.y);
  await mouse('mouseReleased', p.x, p.y);
  await sleep(280);
  return true;
};

const reload = async () => {
  await send('Page.reload', { ignoreCache: true });
  await sleep(1200);
};

await send('Runtime.enable');
await send('Page.enable');
await sleep(900);

console.log('== 周规划 · 端到端自检 ==');

/* 1. 开合 */
const closed0 = await js(`!document.querySelector('.pw')`);
await clickEl(`document.getElementById('planBtn')`);
const opened = await js(`!!document.querySelector('.pw')`);
if (closed0 && opened) ok('顶栏「规划」把窗口打开');
else bad(`开合异常：初始关闭=${closed0} 点后打开=${opened}`);

/* 2. 新增一条 */
await clickEl(`document.querySelector('.pw-add')`);
await js(`(() => {
  const t = document.querySelector('.pw-edit input.t');
  t.value = '复习模电';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  const n = document.querySelector('.pw-edit input.n');
  n.value = '第 3 章';
  n.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
// 点标题栏落地：既退出编辑，也不该误开别的编辑
await clickEl(`document.querySelector('.pw-bar .t')`);
await sleep(500);
const rowCount = await js(`document.querySelectorAll('.pw-row').length`);
if (rowCount === 1) ok('新增一条并落地');
else bad(`新增后行数不对：${rowCount}`);

/* 3. 落盘：直接问服务端 */
const week = await js(`document.getElementById('wkKey').textContent`);
const apiPlan = await (await fetch(`${BASE}/api/plan?week=${week}`)).json();
if (apiPlan.plan.length === 1 && apiPlan.plan[0].title === '复习模电' && apiPlan.plan[0].note === '第 3 章') {
  ok('已写入服务端（标题与备注都对）');
} else {
  bad(`服务端数据不对：${JSON.stringify(apiPlan.plan)}`);
}
if (apiPlan.plan.length && !('doneAt' in apiPlan.plan[0])) ok('未完成时不写 doneAt（稀疏）');
else bad('未完成却写了 doneAt');

/* 4. 刷新后还在（刷新后窗口是关的，先按开） */
await reload();
const afterReload = await js(`(() => {
  const b = document.getElementById('planBtn');
  if (!document.querySelector('.pw')) b.click();
  return new Promise((r) => setTimeout(() => {
    const rows = [...document.querySelectorAll('.pw-row')];
    r({
      n: rows.length,
      title: rows[0] ? rows[0].querySelector('.pw-rt').textContent : '',
      note: rows[0] && rows[0].querySelector('.pw-rn') ? rows[0].querySelector('.pw-rn').textContent : '',
    });
  }, 400));
})()`);
if (afterReload.n === 1 && afterReload.title === '复习模电' && afterReload.note === '第 3 章') ok('刷新后条目与备注都还在');
else bad(`刷新后丢了：${JSON.stringify(afterReload)}`);

/* 5. 勾选完成 */
await clickEl(`document.querySelector('.pw-chk')`);
await sleep(400);
const doneState = await js(`(() => {
  const r = document.querySelector('.pw-row');
  return { done: r.classList.contains('done'), pressed: r.querySelector('.pw-chk').getAttribute('aria-pressed') };
})()`);
if (doneState.done && doneState.pressed === 'true') ok('勾选后进入完成态（划线由 .done 承担）');
else bad(`完成态没生效：${JSON.stringify(doneState)}`);

const apiDone = await (await fetch(`${BASE}/api/plan?week=${week}`)).json();
if (apiDone.plan[0] && apiDone.plan[0].doneAt) ok('完成状态已落盘（doneAt）');
else bad('完成状态没落盘');

/* 6. 点行就地改，从标题点进备注不被中断 */
await clickEl(`document.querySelector('.pw-rt')`);
const twoInputs = await js(`(() => {
  const r = document.querySelector('.pw-row');
  return { t: !!r.querySelector('.pw-edit input.t'), n: !!r.querySelector('.pw-edit input.n'), focused: document.activeElement.className };
})()`);
if (twoInputs.t && twoInputs.n) ok('点行后标题与备注都可编辑');
else bad(`编辑态不全：${JSON.stringify(twoInputs)}`);

const np = await rectOf(`document.querySelector('.pw-row .pw-edit input.n')`);
if (!np) {
  bad('备注框在点进之前就消失了');
} else {
  await mouse('mousePressed', np.x, np.y);
  await mouse('mouseReleased', np.x, np.y);
  await sleep(250);
  const st = await js(`({ alive: !!document.querySelector('.pw-row .pw-edit input.n'), focused: document.activeElement.className })`);
  if (st.alive && st.focused === 'n') ok('从标题点进备注，备注框存活并拿到焦点');
  else bad(`点进备注失败：${JSON.stringify(st)}`);
}

await js(`(() => {
  const n = document.querySelector('.pw-row .pw-edit input.n');
  n.value = '改过的备注';
  n.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
// 点窗外落地
await clickEl(`document.querySelector('.stage')`);
await sleep(500);
const afterEdit = await js(`(() => {
  const r = document.querySelector('.pw-row');
  return { editing: !!r.querySelector('.pw-edit'), note: r.querySelector('.pw-rn') ? r.querySelector('.pw-rn').textContent : '' };
})()`);
if (!afterEdit.editing && afterEdit.note === '改过的备注') ok('点窗外退出编辑且备注已保存');
else bad(`退出/保存失败：${JSON.stringify(afterEdit)}`);

const apiNote = await (await fetch(`${BASE}/api/plan?week=${week}`)).json();
if (apiNote.plan[0] && apiNote.plan[0].note === '改过的备注') ok('改过的备注已落盘');
else bad(`备注没落盘：${JSON.stringify(apiNote.plan[0] && apiNote.plan[0].note)}`);

/* 7. 置顶后点别处不收起；未置顶点外面收起 */
// 上一步点窗外已经把窗口收起了，这里先确保它是开的
await js(`if (!document.querySelector('.pw')) document.getElementById('planBtn').click()`);
await sleep(300);
const pinBtn = await js(`(() => {
  const b = [...document.querySelectorAll('.pw-btn')].find((x) => x.title.includes('置顶'));
  return b ? b.title : null;
})()`);
if (!pinBtn) { bad('找不到置顶按钮'); }
await clickEl(`[...document.querySelectorAll('.pw-btn')].find((x) => x.title.includes('置顶'))`);
const pinnedOn = await js(`!!document.querySelector('.pw.pinned')`);
await clickEl(`document.querySelector('.stage')`);
const stillOpen = await js(`!!document.querySelector('.pw')`);
if (pinnedOn && stillOpen) ok('置顶后点别处不收起');
else bad(`置顶行为不对：置顶=${pinnedOn} 仍在=${stillOpen}`);

await clickEl(`[...document.querySelectorAll('.pw-btn')].find((x) => x.title.includes('取消置顶'))`);
await clickEl(`document.querySelector('.stage')`);
const closedNow = await js(`!document.querySelector('.pw')`);
if (closedNow) ok('取消置顶后点外面收起');
else bad('取消置顶后点外面没收起');

/* 8. 一周一份：翻到下一周看不到这周的条目 */
await js(`if (!document.querySelector('.pw')) document.getElementById('planBtn').click()`);
await sleep(300);
await clickEl(`document.getElementById('next')`);
await sleep(1000);
const otherWeek = await js(`(() => ({
  rows: document.querySelectorAll('.pw-row').length,
  title: document.querySelector('.pw-bar .t') ? document.querySelector('.pw-bar .t').textContent : '',
  empty: !!document.querySelector('.pw-empty'),
}))()`);
if (otherWeek.rows === 0 && otherWeek.empty) ok(`翻到下一周是空的（标题「${otherWeek.title}」）`);
else bad(`一周一份失效：${JSON.stringify(otherWeek)}`);

/* 9. 回到本周，条目还在 */
await clickEl(`document.getElementById('todayBtn')`);
await sleep(900);
const back = await js(`(() => {
  if (!document.querySelector('.pw')) document.getElementById('planBtn').click();
  return new Promise((r) => setTimeout(() => r({ n: document.querySelectorAll('.pw-row').length }), 300));
})()`);
if (back.n === 1) ok('回到本周，原来那条还在');
else bad(`回到本周丢了：${JSON.stringify(back)}`);

/* 10. 只有备注没标题：不该发请求、不该 400，回到只读并提示补标题 */
await clickEl(`document.querySelector('.pw-add')`);
await js(`(() => {
  const n = document.querySelector('.pw-edit input.n');
  n.value = '只有备注';
  n.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await clickEl(`document.querySelector('.pw-bar .t')`);
await sleep(600);
const noteOnly = await js(`(() => {
  const r = [...document.querySelectorAll('.pw-row')].find((x) => x.querySelector('.need-title'));
  return {
    editing: !!document.querySelector('.pw-edit'),
    hint: r ? r.querySelector('.pw-rt').textContent : null,
    toast: !!document.querySelector('.toast'),
    rows: document.querySelectorAll('.pw-row').length,
  };
})()`);
if (!noteOnly.editing && noteOnly.hint === '先写个标题' && !noteOnly.toast) {
  ok('只有备注时提示补标题，不发请求、不报错');
} else {
  bad(`只有备注的处理不对：${JSON.stringify(noteOnly)}`);
}
// 收掉这条：它会挡住后续用例
await js(`(() => {
  const r = [...document.querySelectorAll('.pw-row')].find((x) => x.querySelector('.need-title'));
  if (r) r.querySelector('.pw-del').click();
  return true;
})()`);
await sleep(400);

/* 11. 新增后立刻勾选：完成状态要跟着 POST 一起落盘 */
await clickEl(`document.querySelector('.pw-add')`);
await js(`(() => {
  const t = document.querySelector('.pw-edit input.t');
  t.value = '新增即勾选';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await clickEl(`document.querySelector('.pw-bar .t')`);
await sleep(500);
// 勾这一条（最后一行）
await js(`(() => {
  const rows = [...document.querySelectorAll('.pw-row')];
  const last = rows[rows.length - 1];
  last.querySelector('.pw-chk').click();
  return true;
})()`);
await sleep(700);
const freshDone = await (await fetch(`${BASE}/api/plan?week=${week}`)).json();
const freshRow = freshDone.plan.find((x) => x.title === '新增即勾选');
if (freshRow && freshRow.doneAt) ok('新增后立刻勾选，完成状态已落盘');
else bad(`新增即勾选的完成状态没落盘：${JSON.stringify(freshRow)}`);

/* 12. 触屏档：勾选与删除必须手指点得到（CDP 的 touch 事件才带 pointerType=touch） */
const touch = touchFor(send);
const tchk = await rectOf(`document.querySelector('.pw-chk')`);
if (!tchk) {
  bad('触屏档：找不到勾');
} else {
  const wasDone = await js(`document.querySelector('.pw-row').classList.contains('done')`);
  await touch('touchStart', tchk.x, tchk.y);
  await touch('touchEnd', tchk.x, tchk.y);
  await sleep(450);
  const nowDone = await js(`document.querySelector('.pw-row').classList.contains('done')`);
  if (wasDone !== nowDone) ok('触屏：点勾能切换完成');
  else bad(`触屏：点勾没反应（${wasDone} -> ${nowDone}）`);
}

// 触屏删除：删除键在触屏上常显（不靠 hover）
const tdel = await rectOf(`document.querySelector('.pw-del')`);
const delVisible = await js(`(() => {
  const d = document.querySelector('.pw-del');
  return d ? getComputedStyle(d).opacity : '0';
})()`);
if (Number(delVisible) > 0.2) ok(`触屏：删除键常显（opacity ${delVisible}），手指能点到`);
else bad(`触屏：删除键被 hover 藏起来了（opacity ${delVisible}）`);

// 布局体检：图标尺寸、容器高度、命中区。逐字 DOM 比对看不见这些
const layoutFindings = await layoutCheck(js, [
  '.pw-chk', '.pw-del', '.pw-btn', '.pw-add',
  '.tick', '.add', '.ic', '.tag', '.chip',
]);
reportLayout(layoutFindings, ok, bad);

// 触屏拖标题栏：能拖动，且拖动会退出编辑
await clickEl(`document.querySelector('.pw-rt')`);   // 先进入编辑
const editingBeforeDrag = await js(`!!document.querySelector('.pw-edit')`);
const barPos = await rectOf(`document.querySelector('.pw-bar .t')`);
if (barPos) {
  await touch('touchStart', barPos.x, barPos.y);
  await touch('touchMove', barPos.x - 60, barPos.y + 40);
  await touch('touchEnd', 0, 0);
  await sleep(400);
}
const afterTouchDrag = await js(`(() => ({
  editing: !!document.querySelector('.pw-edit'),
  left: Math.round(document.querySelector('.pw').getBoundingClientRect().left),
}))()`);
if (editingBeforeDrag && !afterTouchDrag.editing) ok('触屏：拖标题栏退出编辑');
else bad(`触屏：拖标题栏没退出编辑（进入=${editingBeforeDrag} 退出=${!afterTouchDrag.editing}）`);

if (errors.length) bad(`页面有 ${errors.length} 处运行时异常：${errors[0]}`);
else ok('无运行时异常');

await stop();

console.log('');
if (fail) { console.log(`✗ 未通过：${pass} 项通过 / ${fail} 项失败`); process.exit(1); }
console.log(`✓ 全部通过（${pass} 项）`);
