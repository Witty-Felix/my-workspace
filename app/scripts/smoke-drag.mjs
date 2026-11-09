#!/usr/bin/env node
// 拖拽端到端自检：真浏览器 + 真鼠标事件（CDP Input.dispatchMouseEvent），
// 验的是「落点即时段 / 连拍翻页 / 手机翻天」这些 smoke.sh 看不见的交互。
//
// 用法：node scripts/smoke-drag.mjs        （需要 Node 22+，内置 WebSocket）
// 说明：本地跑，不进 CI —— CI 装浏览器会把零依赖的流水线变脆。
//       本脚本自己起服务（临时 data 目录）与浏览器，跑完都清掉。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const WORK = path.join(APP, '.drag-smoke');
const DATA = path.join(WORK, 'data');
const PORT = Number(process.env.DRAG_PORT || 8191);

const fail = (m) => { console.error(`  ✗ ${m}`); failures++; };
const ok = (m) => console.log(`  ✓ ${m}`);
let failures = 0;

if (typeof WebSocket !== 'function') {
  console.error('需要 Node 22+（内置 WebSocket）。当前 ' + process.version);
  process.exit(2);
}

function findBrowser() {
  const env = [process.env.CHROME_BIN, process.env.EDGE_BIN].filter(Boolean);
  const win = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  const nix = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const p of [...env, ...(process.platform === 'win32' ? win : nix)]) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

const browser = findBrowser();
if (!browser) {
  console.error('没找到 Chrome/Edge，无法验证拖拽。设 CHROME_BIN 指向可执行文件后重试。');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmrf = (p) => { for (let i = 0; i < 5; i++) { try { fs.rmSync(p, { recursive: true, force: true }); return; } catch (_) { /* Windows 句柄还没放 */ } } };

rmrf(WORK);
fs.mkdirSync(DATA, { recursive: true });
spawn(process.execPath, [path.join(HERE, 'lib', 'fixture.js'), path.join(DATA, 'data.json')], { stdio: 'ignore' });

const server = spawn(process.execPath, ['server.js'], {
  cwd: APP,
  env: { ...process.env, PORT: String(PORT), AUTH: 'off', DATA_DIR: DATA },
  stdio: 'ignore',
});
const profile = path.join(WORK, 'profile');
const chrome = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--window-size=1440,900',
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

let ws = null;
const stop = () => {
  try { ws?.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  try { server.kill(); } catch (_) {}
};
process.on('exit', () => { stop(); });

try {
  // 等服务
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch (_) {}
    await sleep(200);
  }
  await sleep(400);

  // 等浏览器开口：端口写在 DevToolsActivePort 第一行
  let dbgPort = 0;
  for (let i = 0; i < 60; i++) {
    const f = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(f)) { dbgPort = Number(fs.readFileSync(f, 'utf8').split('\n')[0]); if (dbgPort) break; }
    await sleep(200);
  }
  if (!dbgPort) throw new Error('浏览器没开调试端口');

  let target = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes(`:${PORT}`));
    if (target) break;
    await sleep(200);
  }
  if (!target) throw new Error('拿不到页面调试目标');

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
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });

  await send('Runtime.enable');
  await send('Page.enable');
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
  await send('Page.reload', {});
  await sleep(1600);
  await js(`document.getElementById('pStrip').children[4].click()`);
  await sleep(300);

  const touch = (type, x, y) => send('Input.dispatchTouchEvent', {
    type, touchPoints: (type === 'touchEnd' || type === 'touchCancel') ? [] : [{ x, y, id: 1 }],
  });
  const atCard = (title) => js(`(() => {
    const c = [...document.querySelectorAll('#pList .card')].find(x => x.querySelector('.title').textContent === ${JSON.stringify(title)});
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const atZone = (slot) => js(`(() => {
    const z = document.querySelector('.zone-layer .zone[data-slot="${slot}"]');
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
    const zones = await js(`document.querySelectorAll('.zone-layer .zone').length`);
    if (ghost === 1 && zones === 3) ok('触屏：长按拿起 → 三格铺开');
    else fail(`触屏：长按后 ghost=${ghost} 投放格=${zones}`);

    const pm = await atZone('pm');
    if (!pm) { await touch('touchCancel', 0, 0); fail('触屏：下午格没找到'); }
    else {
      // 落在「触屏乙」上半 → 位次 0，应该插到它前面
      const above = await atCard('触屏乙');
      const target = above ? { x: above.x, y: above.y - 14 } : pm;
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
      else fail(`触屏位次不对：甲=${jia?.order} 乙=${yi?.order}`);
      const rest = await js(`document.querySelectorAll('.drag-ghost, .zone-layer').length`);
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
      const left = await js(`document.querySelectorAll('.drag-ghost, .zone-layer').length`);
      if (left === 0) ok('触屏：拖拽被打断后回到静止态');
      else fail(`触屏：打断后残留 ${left} 个节点`);
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
  stop();
  await sleep(400);
  rmrf(WORK);
}

console.log('');
if (failures) { console.log(`✗ 拖拽自检未通过（${failures} 项）`); process.exit(1); }
console.log('✓ 拖拽自检全部通过');
