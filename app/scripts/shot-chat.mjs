/* 只截图，不判定：把聊天窗的几个状态各拍一张，用来看它像不像话。
   跑法：AI_KEY=... node scripts/shot-chat.mjs
*/
import { startHarness, sleep } from './lib/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), '..', 'design', 'prototypes', 'cube-loader', 'shots', 'chat');
fs.mkdirSync(OUT, { recursive: true });

const h = await startHarness({ work: '.chat-shot', port: 8196 });
try {
  await h.ready();
  await h.js('location.reload()');
  await sleep(1300);

  const shot = async (name) => {
    const r = await h.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, `${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    console.log('  →', f);
  };

  await shot('01-entry');

  await h.clickEl("document.getElementById('cubeEntry')");
  await sleep(500);
  await shot('02-empty');

  await h.js(`(() => {
    const ta = document.querySelector('.chat-in textarea');
    ta.value = '下周要做一个海报培训，周三前出大纲，周四给张老师看初稿；另外下周重点推进周报模板';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await h.clickEl("document.querySelector('.chat-send')");

  for (let i = 0; i < 60; i++) {
    if (await h.js("document.querySelectorAll('.chat .draft-row').length")) break;
    await sleep(500);
  }
  await sleep(400);
  await shot('03-draft');

  await h.clickEl("document.querySelector('.chat .draft .btn.primary')");
  await sleep(1600);
  await shot('04-written');

  // 手机端
  await h.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await h.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  await shot('05-mobile');
  await h.clickEl("document.getElementById('mChatBtn')");
  await sleep(500);
  await shot('06-mobile-chat');
} finally {
  await h.stop();
}
