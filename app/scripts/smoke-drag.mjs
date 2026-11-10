#!/usr/bin/env node
// 拖拽端到端自检：真浏览器 + 真鼠标事件（CDP Input.dispatchMouseEvent），
// 验的是「落点即时段 / 连拍翻页 / 手机翻天」这些 smoke.sh 看不见的交互。
//
// 用法：node scripts/smoke-drag.mjs        （需要 Node 22+，内置 WebSocket）
// 说明：本地跑，不进 CI —— CI 装浏览器会把零依赖的流水线变脆。
//       本脚本自己起服务（临时 data 目录）与浏览器，跑完都清掉。

import { startHarness, bleedCheck, sleep } from './lib/harness.mjs';

const PORT = Number(process.env.DRAG_PORT || 8191);

const fail = (m) => { console.error(`  ✗ ${m}`); failures++; };
const ok = (m) => console.log(`  ✓ ${m}`);
let failures = 0;

let h = null;
try {
  h = await startHarness({ work: '.drag-smoke', port: PORT, windowSize: '1440,900' });
  const { send, js, mouse, touch, errors } = h;
  await h.ready();
  await sleep(1200);

  const days = await js(`[...document.querySelectorAll('.day')].map(d => d.dataset.date)`);
  const at = async (title) => js(`(() => {
    const card = [...document.querySelectorAll('.day .card')]
      .find(c => c.querySelector('.title').textContent === ${JSON.stringify(title)});
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const zoneAt = async (dayIndex, slot) => js(`(() => {
    const z = document.querySelector('.zone[data-date="${days[dayIndex]}"][data-slot="${slot}"]');
    if (!z) return null;
    const r = z.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.7 };
  })()`);
  const dragTo = async (title, dayIndex, slot) => {
    const src = await at(title);
    if (!src) return '找不到卡片 ' + title;
    await mouse('mousePressed', src.x, src.y);
    await mouse('mouseMoved', src.x + 14, src.y + 9);
    await sleep(60);
    const z = await zoneAt(dayIndex, slot);
    if (!z) { await mouse('mouseReleased', src.x + 14, src.y + 9); return '拖起来后没有投放格'; }
    await mouse('mouseMoved', z.x, z.y);
    await sleep(60);
    await mouse('mouseReleased', z.x, z.y);
    await sleep(400);
    return null;
  };
  const persisted = async () => (await (await fetch(`http://127.0.0.1:${PORT}/api/items?from=${days[0]}&to=${days[6]}`)).json()).items;

  console.log('== 桌面：落位 ==');
  let err = await dragTo('夹具甲', 3, 'am');
  let list = await persisted();
  let a = list.find((i) => i.title === '夹具甲');
  if (err) fail(err);
  else if (a?.date === days[3] && a?.slot === 'am') ok('空白天随手丢 → 上午');
  else fail(`落点不对：${a?.date} ${a?.slot}`);

  err = await dragTo('夹具乙', 3, 'eve');
  list = await persisted();
  const b = list.find((i) => i.title === '夹具乙');
  if (err) fail(err);
  else if (b?.date === days[3] && b?.slot === 'eve') ok('跨段拖拽改归晚上');
  else fail(`跨段落点不对：${b?.date} ${b?.slot}`);

  console.log('== 接口：校验 ==');
  const r400 = await fetch(`http://127.0.0.1:${PORT}/api/items/fx-a/place`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: days[3], slot: 'xx', index: 0 }),
  });
  const r404 = await fetch(`http://127.0.0.1:${PORT}/api/items/nope/place`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: days[3], slot: 'am', index: 0 }),
  });
  if (r400.status === 400 && r404.status === 404) ok('非法时段 400 / 不存在的 id 404');
  else fail(`校验状态码不对：${r400.status} / ${r404.status}`);

  console.log('== 桌面：贴边连拍 ==');
  const day0 = days[0];
  const before = await at('夹具丙');
  await mouse('mousePressed', before.x, before.y);
  await mouse('mouseMoved', before.x + 14, before.y + 9);
  await sleep(60);
  await mouse('mouseMoved', 4, 300);
  await sleep(2400);
  const flippedDays = await js(`[...document.querySelectorAll('.day')].map(d => d.dataset.date)`);
  const weeks = Math.round((new Date(flippedDays[0]) - new Date(day0)) / (7 * 86400000));
  await mouse('mouseReleased', 4, 300);
  await sleep(400);
  if (weeks <= -2 && weeks >= -4) ok(`停在不放就按节拍翻页（2.4 秒翻了 ${-weeks} 周）`);
  else fail(`翻页节拍不对：2.4 秒翻了 ${-weeks} 周（应 2~3）`);

  const c = (await persisted()).find((i) => i.title === '夹具丙');
  if (c?.date === days[1]) ok('边缘松手不落位');
  else fail(`边缘松手把卡挪走了：${c?.date}`);

  console.log('== 手机：翻天与丢周条 ==');
  await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: true });
  await send('Page.reload', {});
  await sleep(1600);

  // 重新加载会把周次拉回本周；今天的列表可能是空的，先点到有卡的那天（周四）
  await js(`document.getElementById('pStrip').children[3].click()`);
  await sleep(250);

  const chip = await js(`(() => {
    const r = document.getElementById('pStrip').children[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const mCard = await js(`(() => {
    const card = document.querySelector('#pList .card');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { title: card.querySelector('.title').textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!mCard) fail('手机列表里没有可拖的卡');
  else {
    await mouse('mousePressed', mCard.x, mCard.y);
    await mouse('mouseMoved', mCard.x + 14, mCard.y + 9);
    await sleep(80);
    await mouse('mouseMoved', chip.x, chip.y);
    await sleep(80);
    await mouse('mouseReleased', chip.x, chip.y);
    await sleep(500);
    const got = (await persisted()).find((i) => i.title === mCard.title);
    if (got?.date === days[0]) ok('丢到周条某天（时段不变）');
    else fail(`周条投放到 ${got?.date}，应 ${days[0]}`);
  }

  const d0 = await js(`document.getElementById('pDay').textContent`);
  const m2 = await js(`(() => {
    const card = document.querySelector('#pList .card');
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!m2) fail('手机第二张卡没找到');
  else {
    await mouse('mousePressed', m2.x, m2.y);
    await mouse('mouseMoved', m2.x + 14, m2.y + 9);
    await sleep(80);
    await mouse('mouseMoved', 476, 400);
    await sleep(1600);
    const d1 = await js(`document.getElementById('pDay').textContent`);
    await mouse('mouseReleased', 476, 400);
    await sleep(300);
    if (d0 !== d1) ok('贴边连拍翻天');
    else fail('贴边没翻天');
  }

  // 触屏：真机上的三种手势。CDP 的 touch 事件才会带 pointerType=touch，
  // 鼠标事件走不到「隐式指针捕获」那条路，所以这档不能省。
  console.log('== 手机：触屏 ==');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const tDay = days[4];
  for (const [slot, title] of [['am', '触屏甲'], ['pm', '触屏乙']]) {
    await fetch(`http://127.0.0.1:${PORT}/api/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: tDay, slot, title, note: '' }),
    });
  }
  // 把下午塞到溢出的量级：格子均分时这里会压到「晚上」，按内容分高时它自己长高。
  // 没有这份压力，下面的越界断言就是空跑 —— 少几张卡永远测不出挤压。
  for (let k = 0; k < 5; k++) {
    await fetch(`http://127.0.0.1:${PORT}/api/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: tDay, slot: 'pm', title: '压格夹具' + k, note: '占位' }),
    });
  }
  await send('Page.reload', {});
  await sleep(1600);
  await js(`document.getElementById('pStrip').children[4].click()`);
  await sleep(300);

  const atCard = (title) => js(`(() => {
    const c = [...document.querySelectorAll('#pList .card')].find(x => x.querySelector('.title').textContent === ${JSON.stringify(title)});
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const atZone = (slot) => js(`(() => {
    const z = document.querySelector('.phone-list.dropping .zone[data-slot="${slot}"]');
    if (!z) return null;
    const r = z.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
  })()`);

  const t1 = await atCard('触屏甲');
  if (!t1) fail('手机列表里没有触屏夹具');
  else {
    // 没长按就滑：应当当滚动处理，不拿起
    await touch('touchStart', t1.x, t1.y);
    await touch('touchMove', t1.x, t1.y - 26);
    await sleep(80);
    const swiped = await js(`document.querySelectorAll('.drag-ghost').length`);
    await touch('touchEnd', 0, 0);
    await sleep(250);
    if (swiped === 0) ok('触屏：没长按就滑，不拿起');
    else fail('触屏：没长按也被拿起了');

    // 长按 350ms 再动：应当拿起并铺开三格
    const src = await atCard('触屏甲');
    await touch('touchStart', src.x, src.y);
    await sleep(360);
    await touch('touchMove', src.x, src.y + 6);
    await sleep(80);
    const ghost = await js(`document.querySelectorAll('.drag-ghost').length`);
    const zones = await js(`document.querySelectorAll('.phone-list.dropping .zone').length`);
    if (ghost === 1 && zones === 3) ok('触屏：长按拿起 → 三格铺开');
    else fail(`触屏：长按后 ghost=${ghost} 投放格=${zones}`);

    const pm = await atZone('pm');
    if (!pm) { await touch('touchCancel', 0, 0); fail('触屏：下午格没找到'); }
    else {
      // 拖拽态的几何底线：卡片不得越过自己格子的下沿（越过就是画到下一格上）。
      // 2026-11-10 的「晚上那筐被盖住」正是这一条漏检，靠肉眼才发现。
      const b = await bleedCheck(js, 'body.dragging');
      if (b.over === 0) ok(`触屏：三格各装自己的卡，无一张越界（${b.total} 张）`);
      else fail(`触屏：${b.over}/${b.total} 张卡片越出自己的格，会盖住下一格`);

      // 空白时段保底 96px：纯落点要比卡片格更好丢
      const emptyH = await js(`(() => {
        const z = document.querySelector('.phone-list.dropping .zone.empty');
        return z ? Math.round(z.getBoundingClientRect().height) : null;
      })()`);
      if (emptyH === null) fail('触屏：没找到空白时段格');
      else if (emptyH >= 96) ok(`触屏：空白时段保底 ${emptyH}px`);
      else fail(`触屏：空白时段只有 ${emptyH}px，低于 96px 保底`);

      // 流内三格：拖拽态列表重排过，静止态卡坐标已失效。瞄「第一张卡的上四分之一」而不是
      // 格子百分比 —— 格子按内容长高后，25% 会落到第二张卡上，「插到最前」就测不出来了。
      const pmRect = await js(`(() => {
        const z = document.querySelector('.phone-list.dropping .zone[data-slot="pm"]');
        const c = z && z.querySelector('.card');
        if (!z || !c) return null;
        const zr = z.getBoundingClientRect();
        const cr = c.getBoundingClientRect();
        return { x: zr.left + zr.width / 2, y: cr.top + Math.min(6, cr.height * 0.2) };
      })()`);
      const target = pmRect || pm;
      await touch('touchMove', target.x, target.y);
      await sleep(100);
      await touch('touchEnd', 0, 0);
      await sleep(700);
      const list = await persisted();
      const jia = list.find((i) => i.title === '触屏甲');
      const yi = list.find((i) => i.title === '触屏乙');
      if (jia?.date === tDay && jia?.slot === 'pm') ok('触屏：松手落到下午');
      else fail(`触屏落点不对：${jia?.date} ${jia?.slot}`);
      if (jia && yi && jia.order < yi.order) ok('触屏：落在卡片上半 → 位次插到前面');
      else fail(`触屏位次不对：甲=${jia?.order} 乙=${yi?.order}`);      const rest = await js(`document.querySelectorAll('.drag-ghost, .drag-anchor').length`);
      if (rest === 0) ok('触屏：松手后不留残影');
      else fail(`触屏：松手后还剩 ${rest} 个节点`);
    }

    // 拖到一半被打断（来电、系统手势）：界面必须回到静止态
    const t2 = await atCard('触屏乙');
    if (t2) {
      await touch('touchStart', t2.x, t2.y);
      await sleep(360);
      await touch('touchMove', t2.x, t2.y + 8);
      await sleep(80);
      await touch('touchCancel', 0, 0);
      await sleep(400);
      const left = await js(`document.querySelectorAll('.drag-ghost, .drag-anchor').length`);
      if (left === 0) ok('触屏：拖拽被打断后回到静止态');
      else fail(`触屏：打断后残留 ${left} 个节点`);
    }

    // 触屏安全的核心断言：翻页后 touch 序列必须仍存活。
    // touch 目标是 pointerdown 时的原卡节点——列表一重建它就死、浏览器就 pointercancel。
    // 现方案把原卡摘离列表挂到 body 直属锚点，翻页/翻天随便重建。
    // 手势纪律：大跨度移动用插值小步（瞬移 touchMove 会触发浏览器手势判定）。
    console.log('== 手机：触屏翻页后拖拽存活 ==');
    const t3 = await atCard('触屏乙');
    if (!t3) fail('存活测试没卡可拖');
    else {
      const day0 = await js(`document.getElementById('pDay').textContent`);
      await touch('touchStart', t3.x, t3.y);
      await sleep(380);
      await touch('touchMove', t3.x + 4, t3.y + 3);
      await sleep(60);
      // 插值滑到右缘（34px 内）等连拍翻天
      for (let k = 1; k <= 10; k++) {
        await touch('touchMove', t3.x + 4 + (389 - t3.x - 4) * (k / 10), t3.y + 3 + (400 - t3.y - 3) * (k / 10));
        await sleep(30);
      }
      await sleep(700);
      const day1 = await js(`document.getElementById('pDay').textContent`);
      // 手指不抬，从边缘移回纸面中央的晚上格落位——翻页后序列还活着就落得进去
      const eve = await js(`(() => {
        const z = document.querySelector('.phone-list.dropping .zone[data-slot="eve"]');
        if (!z) return null;
        const r = z.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: Math.min(r.top + r.height / 2, innerHeight - 20) };
      })()`);
      if (eve) {
        for (let k = 1; k <= 8; k++) {
          await touch('touchMove', 389 + (eve.x - 389) * (k / 8), 400 + (eve.y - 400) * (k / 8));
          await sleep(30);
        }
        await sleep(100);
      }
      await touch('touchEnd', 0, 0);
      await sleep(700);
      // app 无 HUD：落位与否直接看服务端数据（翻天一天后卡片应落在那天的 eve）
      const list = await persisted();
      const yi = list.find((i) => i.title === '触屏乙');
      if (day1 !== day0) ok(`触屏：贴边翻天（${day1.split(/\s+/)[0]}）`);
      else fail(`触屏：贴边没翻天（day0=${day0} day1=${day1}）`);
      // day1 形如「周二11.10」；把卡片日期换算成同形再比
      const flippedDay = day1.match(/(\d{2})\.(\d{2})/);
      const targetDate = flippedDay
        ? `${new Date().getFullYear()}-${flippedDay[1]}-${flippedDay[2]}`
        : null;
      if (yi?.date === targetDate) ok('触屏：翻页后拖拽仍存活并落位 —— touch 目标没被销毁');
      else fail(`触屏：翻页后拖拽被 pointercancel 或落位不对（卡在 ${yi?.date}，预期 ${targetDate}）`);
    }
  }

  // 编辑框按 visualViewport 摆：至少保证没键盘时整个框和保存键都在可见区内
  const tap = await atCard('触屏乙');
  if (!tap) fail('触屏：找不到可点的卡');
  else {
    await touch('touchStart', tap.x, tap.y);
    await touch('touchEnd', tap.x, tap.y);
    await sleep(450);
    const box = await js(`(() => {
      const ed = document.getElementById('editor');
      if (!ed.open) return null;
      const r = ed.getBoundingClientRect();
      const s = ed.querySelector('.primary').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, save: s.bottom, h: innerHeight, w: innerWidth };
    })()`);
    if (!box) fail('触屏：点卡片没打开编辑框');
    else if (box.top >= 0 && box.bottom <= box.h && box.left >= 0 && box.right <= box.w && box.save <= box.h) ok('编辑框整个留在可见区（保存键够得着）');
    else fail(`编辑框超出可见区：${JSON.stringify(box)}`);
    await js(`document.getElementById('cancelBtn').click()`);
    await sleep(250);
  }

  // 没长按就滑 = 滚页面。把一天塞满、视口压矮，看滚动是否真的发生
  console.log('== 手机：触屏滚动 ==');
  for (let k = 0; k < 12; k++) {
    await fetch(`http://127.0.0.1:${PORT}/api/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: days[5], slot: 'am', title: '滚动夹具' + k, note: '' }),
    });
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 520, deviceScaleFactor: 2, mobile: true });
  await send('Page.reload', {});
  await sleep(1600);
  await js(`document.getElementById('pStrip').children[5].click()`);
  await sleep(300);
  const scrollBefore = await js('window.scrollY');
  for (let k = 0; k < 3; k++) {
    const c = await atCard('滚动夹具' + k);
    if (!c) break;
    await touch('touchStart', c.x, c.y);
    await touch('touchMove', c.x, c.y - 60);
    await sleep(40);
    await touch('touchEnd', 0, 0);
    await sleep(220);
  }
  const scrollAfter = await js('window.scrollY');
  if (scrollAfter > scrollBefore) ok(`触屏：没长按就滑能滚页面（scrollY ${scrollBefore}→${scrollAfter}）`);
  else fail(`触屏：滑动没滚起来（scrollY ${scrollBefore}→${scrollAfter}）`);

  if (errors.length) fail('页面抛了脚本异常：' + errors.join(' | '));
  else ok('全程无脚本异常');
} catch (e) {
  fail(e.message);
} finally {
  if (h) await h.stop();
}

console.log('');
if (failures) { console.log(`✗ 拖拽自检未通过（${failures} 项）`); process.exit(1); }
console.log('✓ 拖拽自检全部通过');
