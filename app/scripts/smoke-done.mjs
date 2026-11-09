#!/usr/bin/env node
// 完成态自检：真服务 + 真浏览器。验接口的稀疏/幂等/校验，和界面上的勾选、刷新、取消、
// 键盘、已完成卡仍可拖。本地跑，不进 CI —— 和 smoke-drag 一样自己起服务与浏览器。
// 用法：npm run smoke:done
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, touchFor } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const WORK = path.join(APP, '.done-smoke');
const DATA = path.join(WORK, 'data');
const PROFILE = path.join(WORK, 'profile');
const PORT = Number(process.env.DONE_PORT || 8193);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmrf = (p) => { for (let i = 0; i < 5; i++) { try { fs.rmSync(p, { recursive: true, force: true }); return; } catch (_) { /* Windows 句柄还没放 */ } } };

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => { bad++; console.log('  ✗ ' + m); };

const browser = findBrowser();
if (!browser) { console.error('没找到 Chrome/Edge，无法验证完成态'); process.exit(2); }
if (typeof WebSocket !== 'function') { console.error('需要 Node 22+（内置 WebSocket）'); process.exit(2); }

rmrf(WORK);
fs.mkdirSync(DATA, { recursive: true });
spawn(process.execPath, [path.join(HERE, 'lib', 'fixture.js'), path.join(DATA, 'data.json')], { stdio: 'ignore' });

const server = spawn(process.execPath, ['server.js'], {
  cwd: APP, env: { ...process.env, PORT: String(PORT), AUTH: 'off', DATA_DIR: DATA }, stdio: 'ignore',
});
const chrome = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`,
  '--window-size=1440,1000', `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

let ws = null;
const stop = () => {
  try { ws?.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  try { server.kill(); } catch (_) {}
};

const call = async (method, p, body) => {
  const r = await fetch(BASE + p, body ? {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { method });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
};

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (_) {}
    await sleep(200);
  }
  if (!(await fetch(BASE + '/api/health').catch(() => null))) throw new Error('服务没起来');

  let dbg = 0;
  for (let i = 0; i < 60; i++) {
    const f = path.join(PROFILE, 'DevToolsActivePort');
    if (fs.existsSync(f)) { dbg = Number(fs.readFileSync(f, 'utf8').split('\n')[0]); if (dbg) break; }
    await sleep(200);
  }
  if (!dbg) throw new Error('浏览器没开调试端口');

  let target = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
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
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: buttons ?? (type === 'mouseReleased' ? 0 : 1), clickCount: 1,
  });
  const rectOf = (expr) => js(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const clickEl = async (expr) => {
    const p = await rectOf(expr);
    if (!p) return false;
    await mouse('mousePressed', p.x, p.y);
    await mouse('mouseReleased', p.x, p.y);
    await sleep(320);
    return true;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1400);

  console.log('== 接口 ==');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const made = await call('POST', '/api/items', { date: today, slot: 'am', title: '完成态自检', note: '' });
  const id = made.j?.item?.id;
  if (made.status === 201 && id && !('doneAt' in made.j.item)) ok('新建不带 doneAt'); else fail('新建就带了 doneAt 或建卡失败');

  const d1 = await call('PATCH', `/api/items/${id}`, { done: true });
  const t1 = d1.j?.item?.doneAt;
  if (d1.status === 200 && t1) ok('完成写入时间戳'); else fail('完成失败');
  await sleep(5);
  const d2 = await call('PATCH', `/api/items/${id}`, { done: true });
  if (d2.j?.item?.doneAt === t1) ok('重复完成幂等'); else fail('重复完成改了时间戳');

  const undo = await call('PATCH', `/api/items/${id}`, { done: false });
  if (undo.status === 200 && !('doneAt' in (undo.j?.item || {}))) ok('取消完成删字段'); else fail('取消后仍有 doneAt');
  const badType = await call('PATCH', `/api/items/${id}`, { done: 'yes' });
  if (badType.status === 400) ok('非布尔 → 400'); else fail('坏类型没拦住');
  const missing = await call('PATCH', '/api/items/nope', { done: true });
  if (missing.status === 404) ok('不存在 → 404'); else fail('404 不对');

  console.log('== 界面 ==');
  const T = '夹具甲';
  const card = `[...document.querySelectorAll('.day .card')].find(c => c.querySelector('.title').textContent === ${JSON.stringify(T)})`;
  const state = () => js(`(() => { const c = ${card}; return c ? { done: c.classList.contains('done'), editor: document.getElementById('editor').open } : null; })()`);
  const apiItem = async () => (await (await fetch(`${BASE}/api/items?from=2000-01-01&to=2100-01-01`)).json()).items.find((i) => i.title === T);

  const tickCount = await js(`document.querySelectorAll('.day .card .tick').length`);
  const cardCount = await js(`document.querySelectorAll('.day .card').length`);
  if (tickCount === cardCount && cardCount > 0) ok(`每张卡都有勾（${cardCount}）`); else fail(`勾数量不对：${tickCount}/${cardCount}`);

  if (!(await clickEl(card + '.querySelector(".tick")'))) fail('点不到勾');
  let s = await state();
  if (s?.done) ok('点勾 → 完成态'); else fail('点了没完成');
  if (s?.editor === false) ok('点勾不打开编辑框'); else fail('点勾打开了编辑框');
  if ((await apiItem())?.doneAt) ok('服务端有 doneAt'); else fail('服务端没写入');

  await send('Page.reload');
  await sleep(1400);
  s = await state();
  if (s?.done) ok('刷新后仍是完成态'); else fail('刷新后丢了');

  if (await clickEl(card + '.querySelector(".tick")')) {
    s = await state();
    if (s && !s.done) ok('再点取消完成'); else fail('取消不了');
    if (!('doneAt' in ((await apiItem()) || {}))) ok('取消后服务端字段没了'); else fail('服务端还有 doneAt');
  }

  await js(`(() => { const c = ${card}; c.querySelector('.tick').focus(); })()`);
  const active = await js(`document.activeElement.className`);
  if (active === 'tick') ok('焦点能到勾上'); else fail('焦点不在勾上：' + active);
  await send('Page.bringToFront');
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(350);
  s = await state();
  if (s?.done && s?.editor === false) ok('键盘 Enter 能勾且不开编辑框'); else fail('键盘路径不对');

  if (!(await state())?.done) await clickEl(card + '.querySelector(".tick")');
  const days = await js(`[...document.querySelectorAll('.day')].map(d => d.dataset.date)`);
  const src = await rectOf(card);
  await mouse('mousePressed', src.x, src.y);
  await mouse('mouseMoved', src.x + 14, src.y + 9);
  await sleep(80);
  if ((await js(`document.querySelectorAll('.drag-ghost .tick').length`)) === 0) ok('拖影里没有勾'); else fail('拖影带着勾');
  const zone = await rectOf(`document.querySelector('.zone[data-date="${days[3]}"][data-slot="pm"]')`);
  if (!zone) { await mouse('mouseReleased', src.x + 14, src.y + 9); fail('拖起来后没有投放格'); }
  else {
    await mouse('mouseMoved', zone.x, zone.y, 1);
    await sleep(80);
    await mouse('mouseReleased', zone.x, zone.y);
    await sleep(700);
    const moved = await apiItem();
    if (moved?.date === days[3] && moved?.slot === 'pm' && moved?.doneAt) ok('已完成卡能拖，完成态不丢');
    else fail(`拖完不对：${moved?.date} ${moved?.slot} done=${!!moved?.doneAt}`);
  }

  // 触屏一遍：鼠标事件不会触发隐式指针捕获，触屏的问题只有 touch 事件能照出来
  console.log('== 触屏：已划掉的卡仍可拖 ==');
  const to = touchFor(send);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.reload');
  await sleep(1700);
  await js(`document.getElementById('pStrip').children[3].click()`);
  await sleep(300);

  const doneCard = await js(`(() => {
    const c = [...document.querySelectorAll('#pList .card')].find(x => x.querySelector('.title').textContent === ${JSON.stringify(T)});
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, done: c.classList.contains('done') };
  })()`);
  if (!doneCard) fail('触屏：那天找不到已完成的那张卡');
  else if (!doneCard.done) fail('触屏：卡不在完成态');
  else {
    await to('touchStart', doneCard.x, doneCard.y);
    await sleep(380);
    await to('touchMove', doneCard.x, doneCard.y + 8);
    await sleep(90);
    const ghost = await js(`document.querySelectorAll('.drag-ghost').length`);
    const amZone = await js(`(() => {
      const z = document.querySelector('.zone-layer .zone[data-slot="am"]');
      if (!z) return null;
      const r = z.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
    })()`);
    if (ghost !== 1 || !amZone) {
      await to('touchCancel', 0, 0);
      fail(`触屏：拿不起来（ghost=${ghost} 上午格=${!!amZone}）`);
    } else {
      await to('touchMove', amZone.x, amZone.y);
      await sleep(100);
      await to('touchEnd', 0, 0);
      await sleep(800);
      const moved = await apiItem();
      if (moved?.date === days[3] && moved?.slot === 'am' && moved?.doneAt) ok('触屏：已完成的卡能拖，完成态不丢');
      else fail(`触屏拖完不对：${moved?.date} ${moved?.slot} done=${!!moved?.doneAt}`);
    }
  }

  if (errors.length) fail('页面有异常：' + errors.join(' / '));
} catch (e) {
  console.error('  ✗ 自检失败：', e.message);
  bad++;
} finally {
  stop();
  await sleep(400);
  rmrf(WORK);
}

console.log(bad ? '\n✗ 完成态自检未通过' : '\n✓ 完成态自检全部通过');
process.exitCode = bad ? 1 : 0;
