/* 布局体检：DOM 结构对了、尺寸却坏掉的那一类错误。
   2026-11-11 两次栽在同一件事上——SVG 只写 viewBox 没写宽高，
   浏览器按 300×150 渲染，一个 14px 的加号撑成 281px，把列表挤到 4px 高，
   点击全部落空。逐字 DOM 比对看不见这种问题，它只比结构不比尺寸。

   三条断言，都是一眼能判的：
     1. 图标不超大：页面里每个 <svg> 的宽高都该在 32px 以内
     2. 容器不塌陷：可滚动列表的高度不能是 0
     3. 命中区够大：可点元素不小于 24px（触屏标准，见 CODING_STANDARDS「界面」）

   用法（在 CDP 会话里）：
     const bad = await layoutCheck(js, ['.pw-list', '.card .title']);
     if (bad.length) { ... 逐条报 ... } */

export const layoutCheck = async (js, clickables = []) => js(`(() => {
  const out = [];

  // 隐藏的东西不参与体检：display:none 的另一套容器、没打开的弹框，量出来都是 0
  const hidden = (el) => {
    if (!el || !el.isConnected) return true;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    if (el.closest('dialog:not([open])')) return true;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  };

  // 1. 图标不超大。装饰性插图（有 aria-hidden 的整块图）不算图标
  for (const s of document.querySelectorAll('svg')) {
    if (hidden(s)) continue;
    if (s.closest('.hs__container')) continue;   // 昼夜开关里的星图/云是插图，不是图标
    const r = s.getBoundingClientRect();
    if (r.width > 32 || r.height > 32) {
      out.push({
        kind: 'icon-too-big',
        what: (s.parentElement ? s.parentElement.className : '?') + ' > svg',
        size: Math.round(r.width) + '×' + Math.round(r.height),
      });
    }
  }

  // 2. 容器不塌陷：有 overflow 的容器高度不该是 0
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
    if (hidden(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 1) {
      out.push({ kind: 'collapsed', what: el.className || el.tagName, size: Math.round(r.height) + 'px' });
    }
  }

  // 3. 命中区够大
  const sel = ${JSON.stringify(clickables)};
  for (const one of sel) {
    for (const el of document.querySelectorAll(one)) {
      if (hidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) {
        out.push({ kind: 'hit-too-small', what: one, size: Math.round(r.width) + '×' + Math.round(r.height) });
      }
    }
  }

  return out;
})()`);

/* 把手绘体检结果按人话打出来，返回是否有问题 */
export const reportLayout = (findings, ok, bad) => {
  if (!findings || !findings.length) { ok('布局体检：图标尺寸、容器高度、命中区都正常'); return false; }
  for (const f of findings.slice(0, 8)) {
    if (f.kind === 'icon-too-big') bad(`图标超大：${f.what} 是 ${f.size}（SVG 缺宽高？）`);
    else if (f.kind === 'collapsed') bad(`容器塌陷：${f.what} 高度 ${f.size}`);
    else if (f.kind === 'row-mismatch') bad(`两端条目数不一致：${f.what}`);
    else bad(`命中区偏小：${f.what} 是 ${f.size}（应 ≥24）`);
  }
  if (findings.length > 8) bad(`……另有 ${findings.length - 8} 处`);
  return true;
};

/* 两端一致性：同一份数据渲染在两处时，节点数必须相等。
   2026-11-11 手机端周规划有四个 bug（删除不消失、重复建条、空条残留、Esc 不撤销），
   根因全是「写操作只重画了桌面浮窗」。逐条测太慢，量一下数量就能一次抓住。

   注意：桌面浮窗只在打开时渲染，所以调用前要先把浮窗打开，否则左边恒为 0。 */
export const checkPlanConsistency = async (js) => js(`(() => {
  const pw = document.querySelectorAll('.pw-row').length;
  const m = document.querySelectorAll('.mrow').length;
  const pwOpen = !!document.querySelector('.pw');
  const narrow = window.matchMedia('(max-width:900px)').matches;
  return { pw, m, pwOpen, narrow, dataLen: (typeof plan !== 'undefined' ? plan.length : -1) };
})()`);

/* 只比「当前视口下真正会渲染的那一处」：
   桌面浮窗只在打开时渲染，手机整页只在窄屏渲染。
   比不该出现的那一处恒为 0，会天天误报。 */
export const reportPlanConsistency = (r, ok, bad) => {
  if (!r || r.dataLen < 0) { bad('读不到 plan 数据，无法做两端一致性检查'); return; }
  const bads = [];
  if (r.pwOpen && r.pw !== r.dataLen) bads.push(`浮窗 ${r.pw} 条 ≠ 数据 ${r.dataLen} 条（写操作没重画浮窗）`);
  if (r.narrow && r.m !== r.dataLen) bads.push(`手机端 ${r.m} 条 ≠ 数据 ${r.dataLen} 条（写操作没重画手机端）`);
  if (bads.length) { bads.forEach((b) => bad(b)); return; }
  const which = [r.pwOpen ? `浮窗 ${r.pw}` : null, r.narrow ? `手机 ${r.m}` : null].filter(Boolean).join(' / ');
  ok(`渲染条目数与数据一致（数据 ${r.dataLen}${which ? '，' + which : ''}）`);
};
