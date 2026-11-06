'use strict';
// 对一个服务跑固定接口序列，输出归一化后的结果，供两个版本逐字比对。
// 归一化：随机 id、UUID 时间戳、uptime —— 其余一律保留，状态码也保留。
// 用法：node contract.js <baseUrl>
const BASE = process.argv[2];
if (!BASE) {
  console.error('用法：node contract.js <baseUrl>');
  process.exit(2);
}

const out = [];
const norm = (v) => JSON.parse(JSON.stringify(v, (k, val) => {
  if (k === 'id' || k === 'createdAt' || k === 'updatedAt') return '<x>';
  if (k === 'uptime') return '<x>';
  return val;
}));
const stripUuid = (s) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<x>');

async function call(method, p, body) {
  const res = await fetch(BASE + p, body ? {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { method });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  out.push(`${method} ${stripUuid(p)} -> ${res.status} ${JSON.stringify(norm(parsed))}`);
}

(async () => {
  const from = process.env.FROM;
  const to = process.env.TO;
  await call('GET', '/api/health');
  await call('GET', `/api/items?from=${from}&to=${to}`);
  await call('GET', `/api/items?from=bad&to=${to}`);
  await call('GET', `/api/items?from=${to}&to=${from}`);
  await call('GET', `/api/items?from=${from}`);
  await call('POST', '/api/items', { date: from, slot: 'xx', title: '坏时段' });
  await call('POST', '/api/items', { date: '2026-13-40', slot: 'am', title: '坏日期' });
  await call('POST', '/api/items', { date: from, slot: 'am', title: '   ' });
  await call('POST', '/api/items', { date: from, slot: 'am', title: '新安排', note: '备注' });
  await call('GET', `/api/items?from=${from}&to=${to}`);

  const list = await (await fetch(`${BASE}/api/items?from=${from}&to=${to}`)).json();
  const made = list.items.find((i) => i.title === '新安排');
  if (made) {
    await call('PATCH', `/api/items/${made.id}`, { title: '改过的标题', note: '改过的备注' });
    await call('POST', `/api/items/${made.id}/move`, { dir: 'up' });
    await call('POST', `/api/items/${made.id}/move`, { dir: 'sideways' });
    await call('DELETE', `/api/items/${made.id}`);
  }
  await call('PATCH', '/api/items/不存在', { title: 'x' });
  await call('DELETE', '/api/items/不存在');
  await call('GET', '/api/export');
  await call('GET', `/api/items?from=${from}&to=${to}`);
  await call('GET', '/api/export');
  console.log(out.join('\n'));
})().catch((e) => {
  console.error('接口序列执行失败：', e.message);
  process.exit(1);
});
