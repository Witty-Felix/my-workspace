/* 交互自检的共用脚手架：夹具 + 服务 + 浏览器 + CDP 连接。
   三个 smoke 脚本各自手抄过一遍「起服务 → 等服务就绪 → 等 DevToolsActivePort →
   连 WebSocket → 包 send/js/mouse」，其中「等服务就绪」漏过一次，POST 打空、
   测出全空的假数据白跑一轮。抽到这里，新增自检只写断言。

   用法：
     const h = await startHarness({ work: '.drag-smoke', port: 8191, windowSize: '1440,900' });
     try { ... h.js(...) ... } finally { await h.stop(); }
   参数：
     work        临时目录名（app/ 下，跑完删掉）
     port        端口（被占用时换一个）
     windowSize  '宽,高'
     fixture     是否造夹具，默认 true
*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, touchFor } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows 上句柄还没放时 rmSync 会抛，重试几次
export const rmrf = (p) => {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(p, { recursive: true, force: true }); return; } catch (_) { /* 再试 */ }
  }
};

export async function startHarness({ work, port, windowSize = '1440,900', fixture = true } = {}) {
  if (typeof WebSocket !== 'function') throw new Error(`需要 Node 22+（内置 WebSocket）。当前 ${process.version}`);
  const browser = findBrowser();
  if (!browser) throw new Error('没找到 Chrome/Edge。设 CHROME_BIN 指向可执行文件后重试。');

  const WORK = path.join(APP, work);
  const DATA = path.join(WORK, 'data');
  const PROFILE = path.join(WORK, 'profile');
  const BASE = `http://127.0.0.1:${port}`;

  rmrf(WORK);
  fs.mkdirSync(DATA, { recursive: true });
  if (fixture) {
    spawn(process.execPath, [path.join(HERE, 'fixture.js'), path.join(DATA, 'data.json')], { stdio: 'ignore' });
  }

  const server = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(port), AUTH: 'off', DATA_DIR: DATA },
    stdio: 'ignore',
  });
  const chrome = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE}`,
    `--window-size=${windowSize}`,
    `${BASE}/`,
  ], { stdio: 'ignore' });

  let ws = null;
  const stop = async () => {
    try { ws?.close(); } catch (_) { /* 已关 */ }
    try { chrome.kill(); } catch (_) { /* 已退 */ }
    try { server.kill(); } catch (_) { /* 已退 */ }
    await sleep(400);
    rmrf(WORK);
  };

  // 服务就绪：漏了这一步会让后续 POST 打空，测出全空的假数据
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch (_) { /* 还没起 */ }
    await sleep(200);
  }
  if (!up) { await stop(); throw new Error('服务没起来'); }

  // 浏览器开口：调试端口写在 DevToolsActivePort 第一行
  let dbg = 0;
  for (let i = 0; i < 60; i++) {
    const f = path.join(PROFILE, 'DevToolsActivePort');
    if (fs.existsSync(f)) { dbg = Number(fs.readFileSync(f, 'utf8').split('\n')[0]); if (dbg) break; }
    await sleep(200);
  }
  if (!dbg) { await stop(); throw new Error('浏览器没开调试端口'); }

  let target = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes(`:${port}`));
    if (target) break;
    await sleep(200);
  }
  if (!target) { await stop(); throw new Error('拿不到页面调试目标'); }

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

  const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: buttons ?? (type === 'mouseReleased' ? 0 : 1), clickCount: 1,
  });

  // 元素的中心点；找不到返回 null
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
    await sleep(320);
    return true;
  };

  const touch = touchFor(send);

  return {
    APP, BASE, WORK, DATA, PROFILE,
    send, js, mouse, touch, rectOf, clickEl, errors,
    stop,
    async ready() {
      await send('Runtime.enable');
      await send('Page.enable');
    },
  };
}

/* 拖拽态几何自检：卡片不得越过自己格子的下沿。
   越过的部分就是画在下一格上的部分 —— 2026-11-10 那个「晚上那筐被盖住」
   就是靠这一条才抓得住的（当时四套自检全绿，问题靠肉眼发现）。
   返回 { over, total }：over 为越界张数，total 为参与检查的卡片数。 */
export const bleedCheck = (js, scope = 'body.dragging') => js(`(() => {
  let over = 0, total = 0;
  for (const z of document.querySelectorAll('.zone')) {
    if (!z.closest(${JSON.stringify(scope)})) continue;
    const zb = z.getBoundingClientRect();
    for (const c of z.querySelectorAll('.card')) {
      total++;
      if (c.getBoundingClientRect().bottom > zb.bottom + 1.5) over++;
    }
  }
  return { over, total };
})()`);
