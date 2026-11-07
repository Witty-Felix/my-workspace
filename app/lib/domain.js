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

  // 同组内重新编号：order 连续排到 0..n-1
  const normalizeOrder = (items) => {
    const groups = new Map();
    for (const it of items) {
      const k = groupKey(it);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    for (const list of groups.values()) {
      list.sort(byOrder);
      list.forEach((it, i) => { it.order = i; });
    }
  };

  // 落位：把一条安排挪到 date/slot 那一组的第 index 位，两组的 order 各自重编号。
  // 拖拽是唯一的使用者；服务端与浏览器共用这一份，免得两边算法漂移。
  const placeItem = (items, id, date, slot, index) => {
    const it = items.find((x) => x.id === id);
    if (!it) return false;

    const fromKey = groupKey(it);
    const fromList = items.filter((x) => groupKey(x) === fromKey && x !== it).sort(byOrder);

    it.date = date;
    it.slot = slot;

    const toKey = groupKey(it);
    const toList = items.filter((x) => groupKey(x) === toKey && x !== it).sort(byOrder);
    const at = Math.max(0, Math.min(Math.trunc(index) || 0, toList.length));
    toList.splice(at, 0, it);
    toList.forEach((x, i) => { x.order = i; });
    if (toKey !== fromKey) fromList.forEach((x, i) => { x.order = i; });

    return true;
  };

  return {
    SLOTS, SLOT_LABELS, groupKey, byOrder,
    compareArrangements, slotForHour, normalizeOrder, placeItem,
  };
});
