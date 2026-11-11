/* 截图工具：先量真实视口，再截图，文件名带时间戳。
   两个都踩过的假象，这里一次性堵死：

   1. Windows 显示缩放 125% 时，--window-size=390 实际渲染成 492 的视口。
      于是「右边被裁掉」看起来像布局溢出，其实是窗口比以为的宽。
      → 截图前把 window.innerWidth 读回来，与要的对不上就直接报错，不产出误导图。

   2. 同一个输出路径反复覆盖时，看图工具会返回缓存，让人以为「改动没落地」。
      → 文件名自动带时间戳，每次都是新文件。

   用法：
     node scripts/shot.mjs <页面路径或 URL> <输出目录> [宽] [高] [--variant=M1]
   例：
     node scripts/shot.mjs http://127.0.0.1:8090/ .shots 1440 900
     node scripts/shot.mjs design/prototypes/x/index.html .shots 390 844
*/
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 相对路径按「当前工作目录」解析，猜错根目录比报错更坏。
// 本脚本会被从 app/ 或仓库根调用，两种都该能用。
const ROOT = process.cwd();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [target, outDir = '.shots', wArg = '1440', hArg = '900', ...rest] = process.argv.slice(2);
if (!target) {
  console.error('用法：node scripts/shot.mjs <页面路径或 URL> [输出目录] [宽] [高]');
  process.exit(2);
}
const W = Number(wArg);
const H = Number(hArg);
if (!Number.isFinite(W) || !Number.isFinite(H) || W < 100 || H < 100) {
  console.error(`宽高不合法：${wArg}×${hArg}`);
  process.exit(2);
}

const browser = findBrowser();
if (!browser) { console.error('没找到 Chrome/Edge'); process.exit(2); }
if (typeof WebSocket !== 'function') { console.error(`需要 Node 22+，当前 ${process.version}`); process.exit(2); }

const url = /^https?:\/\//.test(target)
  ? target
  : 'file:///' + path.resolve(ROOT, target).replace(/\\/g, '/');

const OUT = path.resolve(ROOT, outDir);
fs.mkdirSync(OUT, { recursive: true });
const PROFILE = path.join(OUT, `.profile-${process.pid}`);

/* 显示缩放会缩放 --window-size，所以先探一次比例：
   开一个空白页，量 innerWidth / 请求宽度，再按比例放大真正要开的窗口。
   探不出来的机器（比如没有缩放）比例就是 1，不影响。 */
const launch = (winW, winH) => spawn(browser, [
  '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
  '--hide-scrollbars', '--disable-http-cache',
  // 强制 1:1：不加这条，Windows 显示缩放（常见 125%/129%）会把 --window-size 放大，
  // 390 变成 504，截图看起来像右侧被裁、其实布局没问题
  '--force-device-scale-factor=1',
  '--remote-debugging-port=0',
  `--user-data-dir=${PROFILE}`,
  `--window-size=${winW},${winH}`,
  'about:blank',
], { stdio: 'ignore' });

/* 连上去，返回 { send, js, close } */
async function connect() {
  let dbg = 0;
  for (let i = 0; i < 60; i++) {
    const f = path.join(PROFILE, 'DevToolsActivePort');
    if (fs.existsSync(f)) {
      dbg = Number(fs.readFileSync(f, 'utf8').split('\n')[0]);
      if (dbg) break;
    }
    await sleep(200);
  }
  if (!dbg) throw new Error('浏览器没开调试端口');

  let page = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
    await sleep(200);
  }
  if (!page) throw new Error('拿不到页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
  return { send, js, close: () => { try { ws.close(); } catch (_) { /* 已关 */ } } };
}

const kill = (p) => { try { p.kill(); } catch (_) { /* 已退 */ } };
const rmrf = (p) => { for (let i = 0; i < 6; i++) { try { fs.rmSync(p, { recursive: true, force: true }); return; } catch (_) {} } };

/* 视口不靠 --window-size 定，改用 CDP 的 Emulation.setDeviceMetricsOverride。
   两个原因：
     1. Windows 显示缩放会把 --window-size 放大（390 → 492），--force-device-scale-factor=1 压不住
     2. Chromium 无头模式有最小窗口宽度，想开 309 会拿到 492，反推换算永远收敛不了
   Emulation 直接改 CSS 视口，与物理窗口无关，这才是「我要 390 就是 390」。 */
async function openWith() {
  rmrf(PROFILE);
  const c = launch(W, H);
  const k = await connect();
  await k.send('Runtime.enable');
  await k.send('Page.enable');
  await k.send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: W <= 900,   // 窄视口按手机模拟，媒体查询与触摸都按移动端走
  });
  await k.send('Page.navigate', { url });
  await sleep(1400);
  const v = await k.js('({ w: window.innerWidth, h: window.innerHeight })');
  return { chrome: c, conn: k, vp: v };
}

let chrome = null;
let conn = null;
try {
  const s = await openWith();
  chrome = s.chrome;
  conn = s.conn;
  const vp = s.vp;

  if (!vp || Math.abs(vp.w - W) > 2) {
    throw new Error(
      `视口不符：要 ${W}px，实际 ${vp ? vp.w : '?'}px。这张图会让人误判成布局溢出或裁切，已中止。`
    );
  }

  const shot = await conn.send('Page.captureScreenshot', { format: 'png' });
  const b64 = shot.result?.data;
  if (!b64) throw new Error('截图失败：没有返回数据');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.basename(url.split('?')[0], path.extname(url.split('?')[0])) || 'page';
  const file = path.join(OUT, `${base}-${W}x${H}-${stamp}.png`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));

  console.log(`  ✓ ${path.relative(ROOT, file)}`);
  console.log(`    视口 ${vp.w}×${vp.h}，文件 ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
} catch (err) {
  console.error(`  ✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  conn?.close();
  if (chrome) kill(chrome);
  await sleep(500);
  rmrf(PROFILE);
}
