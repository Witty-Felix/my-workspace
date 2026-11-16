// 自检共用：找浏览器、发触屏事件。
import fs from 'node:fs';

// 自检全部打 127.0.0.1，代理只会把它们劫到别处（本机开着全局代理时
// smoke:drag/done 偶发 fetch failed 就是它）。Node 的 fetch 认小写 no_proxy，
// 两个大小写都补上，别让环境变量决定自检能不能跑。
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost,::1';
process.env.no_proxy = '127.0.0.1,localhost,::1';

export function findBrowser() {
  return [
    process.env.CHROME_BIN, process.env.EDGE_BIN,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

/* 触屏必须用 Input.dispatchTouchEvent：只有它带 pointerType=touch，
   也只有它会触发「隐式指针捕获」，而拖拽正是死在那条路上。
   用鼠标事件模拟的用例，永远看不见这个问题。 */
export const touchFor = (send) => (type, x, y) => send('Input.dispatchTouchEvent', {
  type, touchPoints: (type === 'touchEnd' || type === 'touchCancel') ? [] : [{ x, y, id: 1 }],
});
