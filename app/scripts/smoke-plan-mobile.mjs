/* 手机端周规划自检：真浏览器、真服务、真触屏事件，视口 390 宽。
   要证的事：
     1. 手机上能看到「规划」入口（桌面那个按钮在窄屏是隐藏的）
     2. 滑动列表不进入编辑（用户在微信里报的那个问题）
     3. 轻点一行进入编辑，标题与备注都在
     4. 从标题点进备注不被中断
     5. 点空白退出编辑并保存，刷新后还在
     6. 勾选完成并落盘
     7. 切到「当天」再切回「规划」，数据还在
     8. 删除后行真的消失、新建后再改不重复建条（写操作必须重画两端）
   跑法：npm run smoke:plan-mobile
*/
import { startHarness, sleep } from './lib/harness.mjs';
import { layoutCheck, reportLayout, checkPlanConsistency, reportPlanConsistency } from './lib/layout-check.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

/* 390×844 是 iPhone 12/13/14 的逻辑尺寸。
   用 Emulation 定视口而不是 --window-size：Windows 显示缩放会把它放大成 492，
   Chromium 无头还有最小窗口宽度，靠 window-size 收敛不到 390。 */
const h = await startHarness({
  work: '.plan-mobile-smoke',
  port: 8195,
  windowSize: '390,844',
  emptyData: true,
  emulate: { width: 390, height: 844, mobile: true },
});

const { BASE, js, touch, rectOf, errors } = h;

const tap = async (sel) => {
  const p = await rectOf('document.querySelector(' + JSON.stringify(sel) + ')');
  if (!p) return false;
  await touch('touchStart', p.x, p.y);
  await sleep(40);
  await touch('touchEnd', 0, 0);
  await sleep(320);
  return true;
};

await h.ready();
await sleep(900);

console.log('== 手机端周规划 · 自检（390 宽 · 真触屏）==');

/* 0. 视口确认真的是窄屏 */
const vp = await js(`({ w: window.innerWidth, narrow: window.matchMedia('(max-width:900px)').matches })`);
if (vp.narrow) ok(`视口 ${vp.w}px，命中窄屏分支`);
else bad(`视口 ${vp.w}px，没进窄屏分支（后面的断言都不作数）`);

/* 1. 手机上能看到规划入口 */
const entry = await js(`(() => {
  const t = document.getElementById('mtabPlan');
  if (!t) return { found: false };
  const r = t.getBoundingClientRect();
  const cs = getComputedStyle(t);
  return { found: true, visible: r.width > 0 && cs.display !== 'none', text: t.textContent.trim() };
})()`);
if (entry.found && entry.visible) ok(`手机上能看到规划入口（「${entry.text}」）`);
else bad(`手机上找不到规划入口：${JSON.stringify(entry)}`);

/* 2. 造一条规划，用于后续用例 */
const week = await js(`document.getElementById('wkKey').textContent`);
await fetch(`${BASE}/api/plan`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ week, title: '手机端自检条目', note: '原始备注' }),
});
await js(`location.reload()`);
await sleep(1400);

const rowCount = await js(`document.querySelectorAll('.mrow').length`);
if (rowCount >= 1) ok(`规划页渲染出 ${rowCount} 条`);
else bad(`规划页没有条目（${rowCount}）`);

/* 3. 滑动不该进编辑 */
const r0 = await rectOf("document.querySelector('.mrow')");
await touch('touchStart', r0.x, r0.y);
await sleep(40);
await touch('touchMove', r0.x, r0.y - 25);
await sleep(30);
await touch('touchMove', r0.x, r0.y - 45);
await sleep(30);
await touch('touchEnd', 0, 0);
await sleep(400);
const afterSwipe = await js(`!!document.querySelector('.medit')`);
if (!afterSwipe) ok('滑动 45px：没有进入编辑（用户在微信里报的问题）');
else bad('滑动 45px 仍然进入编辑');

/* 4. 轻点进编辑，标题与备注都在 */
await tap('.mrow .mrt');
const editState = await js(`({
  editing: !!document.querySelector('.medit'),
  t: !!document.querySelector('.medit input.t'),
  n: !!document.querySelector('.medit input.n'),
})`);
if (editState.editing && editState.t && editState.n) ok('轻点：标题与备注同时可编辑');
else bad(`编辑态不全：${JSON.stringify(editState)}`);

/* 5. 从标题点进备注不被中断 */
const np = await rectOf("document.querySelector('.medit input.n')");
if (np) {
  await touch('touchStart', np.x, np.y);
  await sleep(40);
  await touch('touchEnd', 0, 0);
  await sleep(300);
}
const noteFocus = await js(`({
  alive: !!document.querySelector('.medit input.n'),
  focused: document.activeElement ? document.activeElement.className : '',
})`);
if (noteFocus.alive && noteFocus.focused === 'n') ok('从标题点进备注：备注框存活并拿到焦点');
else bad(`点进备注失败：${JSON.stringify(noteFocus)}`);

/* 6. 改备注 → 点空白 → 保存 */
await js(`(() => {
  const n = document.querySelector('.medit input.n');
  n.value = '手机端改过的备注';
  return true;
})()`);
const blank = await js(`(() => {
  const y = window.innerHeight - 40;
  return { x: window.innerWidth / 2, y };
})()`);
await touch('touchStart', blank.x, blank.y);
await sleep(40);
await touch('touchEnd', 0, 0);
await sleep(500);
const afterSave = await js(`({
  editing: !!document.querySelector('.medit'),
  note: document.querySelector('.mrow .mrn') ? document.querySelector('.mrow .mrn').textContent : '',
})`);
if (!afterSave.editing && afterSave.note === '手机端改过的备注') ok('点空白：退出编辑并保存');
else bad(`保存失败：${JSON.stringify(afterSave)}`);

const apiAfter = await (await fetch(`${BASE}/api/plan?week=${week}`)).json();
if (apiAfter.plan[0] && apiAfter.plan[0].note === '手机端改过的备注') ok('改过的备注已落盘');
else bad(`备注没落盘：${JSON.stringify(apiAfter.plan[0] && apiAfter.plan[0].note)}`);

/* 7. 勾选完成并落盘 */
await tap('.mrow .mchk');
await sleep(400);
const doneUi = await js(`document.querySelector('.mrow').classList.contains('done')`);
if (doneUi) ok('轻点勾：进入完成态');
else bad('勾没生效');
const apiDone = await (await fetch(`${BASE}/api/plan?week=${week}`)).json();
if (apiDone.plan[0] && apiDone.plan[0].doneAt) ok('完成状态已落盘');
else bad('完成状态没落盘');

/* 8. 切到「当天」再切回，数据还在 */
await tap('#mtabWeek');
const weekShown = await js(`({
  phoneShown: !document.getElementById('phone').hidden,
  planHidden: document.getElementById('mPlan').hidden,
})`);
if (weekShown.phoneShown && weekShown.planHidden) ok('切到「当天」：当天页显示、规划页隐藏');
else bad(`切页不对：${JSON.stringify(weekShown)}`);

await tap('#mtabPlan');
const backToPlan = await js(`({
  rows: document.querySelectorAll('.mrow').length,
  done: document.querySelector('.mrow') ? document.querySelector('.mrow').classList.contains('done') : false,
})`);
if (backToPlan.rows >= 1 && backToPlan.done) ok('切回「规划」：条目与完成态都还在');
else bad(`切回来丢了：${JSON.stringify(backToPlan)}`);

/* 9. 删除必须真的从屏上消失（曾经只重画桌面浮窗，手机端删了还留着） */
const beforeDel = await js(`document.querySelectorAll('.mrow').length`);
await tap('.mrow .mdel');
await sleep(500);
const afterDel = await js(`({
  rows: document.querySelectorAll('.mrow').length,
  empty: !!document.querySelector('.pw-card-empty'),
  count: document.getElementById('mPlanNum') ? document.getElementById('mPlanNum').textContent : '',
})`);
if (afterDel.rows === beforeDel - 1) ok('删除后行从屏上消失');
else bad(`删除没生效：${beforeDel} → ${afterDel.rows}`);
if (afterDel.rows === 0 && !afterDel.empty) bad('删空后没有出现空周提示');
else if (afterDel.rows === 0) ok('删空后出现空周提示');

/* 10. 新增后再改一次，不能重复 POST（闭包里攥着旧 tmp- 对象会重复建条） */
await tap('#mPlanAdd');
await sleep(400);
await js(`(() => {
  const t = document.querySelector('.medit input.t');
  if (t) { t.value = '只该有一条'; }
  return !!t;
})()`);
const blank2 = await js(`({ x: window.innerWidth / 2, y: window.innerHeight - 40 })`);
await touch('touchStart', blank2.x, blank2.y);
await sleep(40);
await touch('touchEnd', 0, 0);
await sleep(700);
// 再点同一行改一次
await tap('.mrow .mrt');
await js(`(() => { const t = document.querySelector('.medit input.t'); if (t) t.value = '改过第二次'; return !!t; })()`);
await touch('touchStart', blank2.x, blank2.y);
await sleep(40);
await touch('touchEnd', 0, 0);
await sleep(700);
const apiDup = await (await fetch(`${BASE}/api/plan?week=${week}`)).json();
const same = apiDup.plan.filter((x) => x.title === '改过第二次' || x.title === '只该有一条');
if (same.length === 1) ok('新建后再改，没有重复建条（仍只有一条）');
else bad(`重复建条：${JSON.stringify(apiDup.plan.map((x) => x.title))}`);

/* 11. 渲染条目数必须与数据一致（写操作漏重画会在这里露出来） */
reportPlanConsistency(await checkPlanConsistency(js), ok, bad);

/* 12. 布局体检：图标尺寸、容器高度、命中区 */
const findings = await layoutCheck(js, ['.mchk', '.mdel', '.mtab', '.pw-card-add', '.chip', '.ic', '.tick']);
reportLayout(findings, ok, bad);

if (errors.length) bad(`运行时异常：${errors[0]}`);
else ok('无运行时异常');

await h.stop();

console.log('');
if (fail) { console.log(`✗ 未通过：${pass} 通过 / ${fail} 失败`); process.exit(1); }
console.log(`✓ 全部通过（${pass} 项）`);
