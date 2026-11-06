'use strict';
// 造一份固定夹具：日期取「本周」，让 DOM 里有东西可渲染。
// 用法：node fixture.js <输出路径>
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
if (!out) {
  console.error('用法：node fixture.js <输出路径>');
  process.exit(2);
}

// 本周周一
const today = new Date();
const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
const day = (offset) => {
  const d = new Date(monday);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const stamp = '2026-01-01T00:00:00.000Z';
const db = {
  version: 1,
  items: [
    { id: 'fx-a', date: day(0), slot: 'am', title: '夹具甲', note: '上午', order: 0, createdAt: stamp, updatedAt: stamp },
    { id: 'fx-b', date: day(0), slot: 'pm', title: '夹具乙', note: '', order: 0, createdAt: stamp, updatedAt: stamp },
    { id: 'fx-c', date: day(1), slot: 'eve', title: '夹具丙', note: '', order: 0, createdAt: stamp, updatedAt: stamp },
  ],
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(db, null, 2), 'utf8');
// 同一目录留下查询区间，供 contract.js 使用
fs.writeFileSync(path.join(path.dirname(out), 'range.env'), `FROM=${day(0)}\nTO=${day(6)}\n`, 'utf8');
console.log(`夹具已写入 ${out}（日期 ${day(0)} ~ ${day(6)}）`);
