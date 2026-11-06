/* 领域常量与排序规则 —— 浏览器与服务端共用同一份真相。
   放在 lib/ 而不是 public/：public/ 只留浏览器直接要的静态资源，
   这个文件由 server.js 用一条显式路由 /domain.js 送出去。
   用法：浏览器 <script src="domain.js"> 拿 window.WBDomain；服务端 require('./lib/domain')。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WBDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 「时段」：一条安排所属的半天档位，只取上午 / 下午 / 晚上三值（见 GLOSSARY.md）
  const SLOTS = ['am', 'pm', 'eve'];
  const SLOT_LABELS = { am: '上午', pm: '下午', eve: '晚上' };

  // 同一时段分组：同一天 + 同一档位 = 同组
  const groupKey = (a) => a.date + '|' + a.slot;

  // 组内先后
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

  // 全局先后：日期 → 时段 → 组内先后
  const compareArrangements = (a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const sa = SLOTS.indexOf(a.slot), sb = SLOTS.indexOf(b.slot);
    if (sa !== sb) return sa - sb;
    return byOrder(a, b);
  };

  // 按钟点选默认时段：12 点前上午，18 点前下午，其余晚上
  const slotForHour = (h) => (h < 12 ? SLOTS[0] : h < 18 ? SLOTS[1] : SLOTS[2]);

  return { SLOTS, SLOT_LABELS, groupKey, byOrder, compareArrangements, slotForHour };
});
