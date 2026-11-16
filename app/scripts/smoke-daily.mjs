/* 每日必做端到端自检：真浏览器、真服务、真接口。
   覆盖的是「看起来没事、其实会坏」的路径：
     1. 顶栏「必做」开抽屉 → 四张卡与进度环在位
     2. 勾选一项 → 计数 1/4、卡完成态 → 刷新后仍是完成（落盘）
     3. 取消 → 刷新后未完成
     4. 勾满四项 → 计数 4/4、顶栏「必做 ✓」
     5. 手机端（390 宽）：入口是顶栏「日」方块，开的是底部抽层（两端不同形），
        勾选一行 → 计数与勾选态 → 落盘
     6. 隔日清零：换一个 day 查询，服务端返回空 —— 清零是查询语义不是删数据
   跑法：npm run smoke:daily
*/
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const WORK = path.join(APP, '.daily-smoke');
const DATA = path.join(WORK, 'data');
const PROFILE = path.join(WORK, 'profile');
const PORT = 8196;
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
  '--force-device-scale-factor=1',
  `--window-size=1440,900`,
  `${BASE}/`,
], { stdio: 'ignore' });

let ws = null;
const stop = async () => {
  try { ws?.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  try { server.kill(); } catch (_) {}
  await sleep(600);   // 等 chrome 真死，否则 profile 锁住，下次 rmrf 失败留下旧的 DevToolsActivePort
  rmrf(WORK);
};
process.on('exit', () => { try { chrome.kill(); server.kill(); } catch (_) {} });

let up = false;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch (_) {}
  await sleep(200);
}
if (!up) { console.error('服务没起来'); await stop(); process.exit(2); }

let dbg = 0;
for (let i = 0; i < 60; i++) {
  const f = path.join(PROFILE, 'DevToolsActivePort');
  if (fs.existsSync(f)) {
    const v = Number(fs.readFileSync(f, 'utf8').split('\n')[0]);
    // 端口要真活着才算数：上次运行的残留文件指向死端口，读到了也不能用
    if (v) {
      try { await fetch(`http://127.0.0.1:${v}/json/version`); dbg = v; break; }
      catch (_) { /* 死端口的旧文件，等浏览器写新的 */ }
    }
  }
  await sleep(200);
}
if (!dbg) { console.error('浏览器没开调试端口'); await stop(); process.exit(2); }

let target = null;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes(`:${PORT}`));
    if (target) break;
  } catch (_) { /* DevToolsActivePort 写了但端口还没监听，再等 */ }
  await sleep(200);
}
if (!target) { console.error('拿不到页面调试目标'); await stop(); process.exit(2); }

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej);
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

await sleep(1500);

/* ---------- 桌面 ---------- */

await js(`document.getElementById('dailyBtn').click()`);
await sleep(600);

if (await js(`!!document.querySelector('.dd-drawer')`)) ok('桌面：顶栏「必做」打开 B 抽屉');
else bad('桌面：B 抽屉没出现');

if ((await js(`document.querySelectorAll('.dd-card').length`)) === 4) ok('桌面：四张卡在位');
else bad('桌面：卡片数不是 4');

if (await js(`!!document.querySelector('.dd-ring .fill')`)) ok('桌面：进度环在位');
else bad('桌面：进度环缺失');

// 勾第一张卡（读书）
await js(`document.querySelector('.dd-card[data-key="read"]').click()`);
await sleep(400);

if ((await js(`document.querySelector('.dd-ringnum').textContent`)) === '1/4') ok('桌面：勾选后计数 1/4');
else bad('桌面：勾选后计数不是 1/4');

if (await js(`document.querySelector('.dd-card[data-key="read"]').classList.contains('done')`)) ok('桌面：卡片完成态点亮');
else bad('桌面：卡片没有完成态');

// 落盘断言：直接查服务端
await sleep(300);
const disk1 = await (await fetch(`${BASE}/api/duties?day=${new Date().toISOString().slice(0, 10)}`)).json();
if (disk1.duties.some((d) => d.key === 'read')) ok('落盘：勾选写入 data.json');
else bad('落盘：服务端没有这条记录');

// 勾满四项
for (const k of ['jieSe', 'tidy', 'kind']) {
  await js(`document.querySelector('.dd-card[data-key="${k}"]').click()`);
  await sleep(150);
}
await sleep(300);
if ((await js(`document.querySelector('.dd-ringnum').textContent`)) === '4/4') ok('桌面：勾满后计数 4/4');
else bad('桌面：勾满后计数不是 4/4');
if ((await js(`document.getElementById('dailyBtn').textContent`)) === '必做 ✓') ok('桌面：顶栏变「必做 ✓」');
else bad('桌面：顶栏没有变「必做 ✓」');

// Esc 收起
await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
await sleep(200);
if (!(await js(`!!document.querySelector('.dd-drawer')`))) ok('桌面：Esc 收起抽屉');
else bad('桌面：Esc 没收起');

/* ---------- 刷新后完成态还在 ---------- */

await send('Page.enable');
await send('Page.navigate', { url: `${BASE}/` });
await sleep(1500);
await js(`document.getElementById('dailyBtn').click()`);
await sleep(600);
if ((await js(`document.querySelector('.dd-ringnum').textContent`)) === '4/4') ok('刷新：完成态从服务端读回 4/4');
else bad('刷新：完成态丢了');
if ((await js(`document.querySelectorAll('.dd-card.done').length`)) === 4) ok('刷新：四张卡都是完成态');
else bad('刷新：完成卡数不对');

// 取消一项 → 落盘 → 刷新后是 3/4
await js(`document.querySelector('.dd-card[data-key="read"]').click()`);
await sleep(400);
await send('Page.navigate', { url: `${BASE}/` });
await sleep(1500);
await js(`document.getElementById('dailyBtn').click()`);
await sleep(600);
if ((await js(`document.querySelector('.dd-ringnum').textContent`)) === '3/4') ok('取消+刷新：3/4（取消也落盘）');
else bad('取消+刷新：计数不是 3/4');

// 近 7 日点阵：今天的取消后最后一位应该是空
const todayDot = await js(`!!document.querySelector('.dd-card[data-key="read"] .dd-dot.today.hit')`);
if (!todayDot) ok('点阵：取消后今天的点熄灭');
else bad('点阵：取消后今天的点还亮着');

// 收起，准备手机端
await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
await sleep(200);

/* ---------- 手机端（390 宽）：入口与形态都不同 ---------- */

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(400);

if (await js(`getComputedStyle(document.getElementById('mDailyBtn')).display !== 'none'`)) ok('手机：顶栏「日」方块入口可见');
else bad('手机：入口不可见');

if ((await js(`getComputedStyle(document.getElementById('dailyBtn')).display`)) === 'none') ok('手机：桌面顶栏「必做」按约定隐藏');
else bad('手机：桌面入口没有隐藏');

await js(`document.getElementById('mDailyBtn').click()`);
await sleep(600);

if (await js(`!!document.querySelector('.dd-sheet')`)) ok('手机：打开的是 A 底部抽层');
else bad('手机：抽层没出现');

if (!(await js(`!!document.querySelector('.dd-drawer')`))) ok('手机：桌面 B 抽屉没有跟过来（两端不同形）');
else bad('手机：桌面抽屉错误地出现在手机端');

if ((await js(`document.querySelectorAll('.dd-row').length`)) === 4) ok('手机：四行勾选在位');
else bad('手机：行数不是 4');

if ((await js(`document.querySelector('.dd-cnt').textContent`)) === '3/4') ok('手机：计数从服务端读回 3/4');
else bad('手机：计数不是 3/4');

// 勾一行 → 落盘 → 计数变 4/4
await js(`document.querySelector('.dd-row[data-key="read"]').click()`);
await sleep(400);
if ((await js(`document.querySelector('.dd-cnt').textContent`)) === '4/4') ok('手机：勾选后计数 4/4');
else bad('手机：勾选后计数不是 4/4');
await sleep(300);
const disk2 = await (await fetch(`${BASE}/api/duties?day=${new Date().toISOString().slice(0, 10)}`)).json();
if (disk2.duties.length === 4) ok('手机：四项全部落盘');
else bad('手机：服务端不足四条');

// 隔日清零：换昨天的 day 查询应为空（清零是查询语义）
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const disk3 = await (await fetch(`${BASE}/api/duties?day=${yesterday}`)).json();
if (disk3.duties.length === 0) ok('隔日：昨天的 day 查询为空（每日更新成立）');
else bad('隔日：昨天的查询不为空');

// 关闭抽层
await js(`document.querySelector('.dd-back--sheet')?.click()`);
await sleep(200);

/* ---------- 静止态 DOM 比对之外：确认没有 JS 异常 ---------- */

if (errors.length === 0) ok('全程无 JS 异常');
else bad(`有 ${errors.length} 个 JS 异常：${errors[0]}`);

console.log(`\n${pass} 项通过，${fail} 项失败`);
await stop();
process.exit(fail ? 1 : 0);
