#!/usr/bin/env node
// 取渲染后的 DOM，给 smoke.sh 的渲染比对兜底：本机 headless 有时 --dump-dom 输出为空。
// 归一化方式与 smoke.sh 的 dump() 保持一致：去掉 script/link/注释与标签间空白。
// 用法：node scripts/lib/dump-dom.mjs <url>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBrowser } from './cdp.mjs';

const url = process.argv[2];
if (!url) { console.error('用法：node dump-dom.mjs <url>'); process.exit(2); }

const browser = findBrowser();
if (!browser) { console.error('没找到 Chrome/Edge'); process.exit(2); }
if (typeof WebSocket !== 'function') { console.error('需要 Node 22+'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dump-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, url,
], { stdio: 'ignore' });

let ws;
try {
  let port = 0;
  for (let i = 0; i < 60; i++) {
    const f = path.join(profile, 'DevToolsActivePort');
    if (fs.existsSync(f)) { port = Number(fs.readFileSync(f, 'utf8').split('\n')[0]); if (port) break; }
    await sleep(200);
  }
  if (!port) throw new Error('浏览器没开调试端口');

  let target = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
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
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  for (let i = 0; i < 40; i++) {
    if (await js('document.querySelectorAll(".card").length')) break;
    await sleep(200);
  }
  const html = await js('document.documentElement.outerHTML');
  process.stdout.write(html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/></g, '>\n<')
    .split('\n').map((s) => s.trim()).filter(Boolean).join('\n'));
} finally {
  try { ws?.close(); } catch (_) {}
  try { chrome.kill(); } catch (_) {}
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
