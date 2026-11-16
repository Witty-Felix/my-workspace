/* 助手自检：立方体 → 聊天窗 → 草案 → 写入 → 纸上有条目。
   只在有 AI_KEY 时跑真实链路；没有 key 就只验证「入口在、窗口开、
   缺 key 时给的是可读的提示」—— 这几条不需要模型也能测。

   跑法：AI_KEY=... node scripts/smoke-chat.mjs
        （AI_BASE / AI_MODEL 缺省用 deepseek 官方）
*/
import { startHarness, sleep } from './lib/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const HAS_KEY = !!process.env.AI_KEY;
let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

const h = await startHarness({ work: '.chat-smoke', port: 8194, emptyData: true });
try {
  await h.ready();
  await h.js('location.reload()');
  await sleep(1200);

  /* 1. 入口在纸外右下角，且没盖住周轴 */
  const geo = await h.js(`(() => {
    const c = document.getElementById('cubeEntry');
    if (!c) return { found: false };
    const r = c.getBoundingClientRect();
    const sheet = document.getElementById('week').getBoundingClientRect();
    return {
      found: true,
      visible: r.width > 0 && r.height > 0,
      // 在纸的右边或下边之外，才算「没压住纸」
      outside: r.left >= sheet.right - 1 || r.top >= sheet.bottom - 1,
      cube: !!c.querySelector('.cube-3d .cube-span'),
    };
  })()`);
  if (!geo.found) bad('找不到立方体入口');
  else if (!geo.visible) bad('立方体入口尺寸为 0');
  else if (!geo.cube) bad('立方体结构缺失（.cube-span）');
  else if (!geo.outside) bad('立方体压在纸上了');
  else ok('立方体在纸外右下角，结构完整');

  /* 2. 点开：窗口出现，且不遮挡整页（非模态） */
  const opened = await h.clickEl("document.getElementById('cubeEntry')");
  if (!opened) bad('点不动立方体');
  else {
    const st = await h.js(`(() => {
      const el = document.querySelector('.chat');
      if (!el) return null;
      return {
        hasLog: !!el.querySelector('.chat-log'),
        hasInput: !!el.querySelector('.chat-in textarea'),
        // 非模态：页面的 .bar 仍能被点到（没有全屏暗罩）
        veil: !!document.querySelector('.chat-veil'),
        z: getComputedStyle(el).zIndex,
      };
    })()`);
    if (!st) bad('点了立方体没出现聊天窗');
    else if (!st.hasLog || !st.hasInput) bad('窗口缺消息区或输入区');
    else if (st.veil) bad('桌面不该有暗罩（要能边看纸边聊）');
    else ok(`聊天窗打开（z-index ${st.z}，无遮罩）`);
  }

  /* 3. 首次打开有引导，且没有假消息 */
  const hint = await h.js("document.querySelectorAll('.chat .msg').length");
  if (hint === 0) ok('空会话不铺假消息');
  else bad(`空会话里已经有 ${hint} 条消息`);

  if (!HAS_KEY) {
    console.log('\n  – 没有 AI_KEY，跳过真实对话与写入两节');
  } else {
    /* 4. 发一句带具体日期的话，等草案卡出现 */
    await h.js(`(() => {
      const ta = document.querySelector('.chat-in textarea');
      // 全用「今天」：说「明天」的话，周日跑的时候会落到下周，
      // 纸上（本周）自然不多卡 —— 那是跨周提示的场景，不是写入失败
      ta.value = '今天上午写海报培训大纲，今天下午给张老师看初稿';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await h.clickEl("document.querySelector('.chat-send')");

    let rows = 0;
    for (let i = 0; i < 60; i++) {
      rows = await h.js("document.querySelectorAll('.chat .draft-row').length");
      if (rows > 0) break;
      await sleep(500);
    }
    if (!rows) {
      const err = await h.js("(document.querySelector('.chat .msg.bot:last-child')||{}).textContent || ''");
      bad(`没出草案（助手回：${String(err).slice(0, 80)}）`);
    } else {
      ok(`草案列出 ${rows} 条`);

      // 每条都带「哪天 + 哪一段」的索引列，不能是空壳
      const keysOk = await h.js(`(() => {
        const ks = [...document.querySelectorAll('.chat .draft-row .draft-k')];
        return ks.length > 0 && ks.every((k) => k.textContent.trim().length > 3);
      })()`);
      if (keysOk) ok('每条草案都标了日期与时段');
      else bad('草案索引列是空的');
    }

    /* 5. 写入：条目真的出现在纸上 */
    const before = await h.js("document.querySelectorAll('#week .card').length");
    await h.clickEl("document.querySelector('.chat .draft .btn.primary')");

    let after = before;
    for (let i = 0; i < 60; i++) {
      after = await h.js("document.querySelectorAll('#week .card').length");
      if (after > before) break;
      await sleep(400);
    }
    if (after > before) ok(`写入后纸上多出 ${after - before} 张卡（${before} → ${after}）`);
    else bad(`写入后纸上没变化（${before} → ${after}）`);

    /* 6. 写完的草案不能再点一次（否则同一句会写两遍） */
    const locked = await h.js(`(() => {
      const c = document.querySelector('.chat .draft');
      return c ? c.classList.contains('done') : false;
    })()`);
    if (locked) ok('已写的草案变灰，不再可点');
    else bad('已写的草案还能再点一次');

    /* 7. 服务端确实收到了，不是只有界面在动 */
    const saved = await h.js(`(async () => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const ymd = (x) => x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
      const from = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 3));
      const to = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3));
      const r = await fetch('api/items?from=' + from + '&to=' + to);
      const j = await r.json();
      return (j.items || []).length;
    })()`);
    if (saved > 0) ok(`服务端库里确实有 ${saved} 条`);
    else bad('服务端库里没有条目');
  }

  /* 8. 手机端：入口在顶栏（.nav 那条窄屏是 display:none，入口不能放那里） */
  await h.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await h.send('Page.reload', { ignoreCache: true });
  await sleep(1300);
  const m = await h.js(`(() => {
    const b = document.getElementById('mChatBtn');
    const nav = document.querySelector('.nav');
    if (!b) return { found: false };
    const r = b.getBoundingClientRect();
    return {
      found: true,
      visible: r.width > 0 && r.height > 0 && r.top < 120,
      navHidden: getComputedStyle(nav).display === 'none',
      desktopCubeHidden: getComputedStyle(document.getElementById('cubeEntry')).display === 'none',
    };
  })()`);
  if (!m.found) bad('手机端没有助手入口');
  else if (!m.visible) bad('手机端入口不可见或不在顶栏');
  else if (!m.navHidden) bad('手机端 .nav 竟然是显示的（这条断言的前提变了）');
  else if (!m.desktopCubeHidden) bad('手机端桌面立方体还占着位置');
  else ok('手机端入口在顶栏，桌面立方体已隐藏');

  /* 9. 手机端打开是底部抽屉 + 暗罩，且占满宽度 */
  await h.clickEl("document.getElementById('mChatBtn')");
  const sheet = await h.js(`(() => {
    const el = document.querySelector('.chat');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      fullWidth: Math.abs(r.width - window.innerWidth) < 2,
      atBottom: Math.abs(r.bottom - window.innerHeight) < 2,
      veil: !!document.querySelector('.chat-veil'),
    };
  })()`);
  if (!sheet) bad('手机端点不出聊天窗');
  else if (!sheet.fullWidth) bad('手机端抽屉没占满宽度');
  else if (!sheet.atBottom) bad('手机端抽屉没贴底');
  else if (!sheet.veil) bad('手机端缺暗罩');
  else ok('手机端是贴底抽屉 + 暗罩');

  const errs = h.errors.filter((e) => !/favicon/i.test(e));
  if (errs.length) bad('运行时报错：' + errs.slice(0, 2).join(' | '));
  else ok('无运行时异常');
} finally {
  await h.stop();
}

console.log(`\n${fail ? '✗' : '✓'} 助手自检：${pass} 过 / ${fail} 败${HAS_KEY ? '' : '（无 AI_KEY，模型那两节未跑）'}`);
if (fail) process.exit(1);
