'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
// 领域常量与排序规则：与浏览器共用同一份（app/lib/domain.js）
const { SLOTS, compareArrangements, groupKey, byOrder, normalizeOrder, placeItem } = require('./lib/domain');
// 存储层：安排数据怎么落盘、怎么读回（app/lib/store.js）
const store = require('./lib/store');

const PORT = Number(process.env.PORT || 8090);
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
// AUTH=off 显式关闭登录：默认仍是 basic，避免误删凭据就把站点裸奔出去
const AUTH_OFF = String(process.env.AUTH || 'basic').toLowerCase() === 'off';

if (!AUTH_OFF && (!AUTH_USER || !AUTH_PASS)) {
  console.error('[fatal] AUTH_USER / AUTH_PASS 未设置，拒绝启动（fail-closed）。确需免登录请设 AUTH=off');
  process.exit(1);
}

// ---------- 校验 ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.slice(0, max);
}

// 周规划的文字要留换行与缩进，不能走 cleanText 那套压平逻辑
function cleanNote(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim().slice(0, max);
}

// 「周」用 ISO 周标识，形如 2026-W46（见 GLOSSARY.md）
const WEEK_RE = /^\d{4}-W\d{2}$/;

function isWeek(s) {
  if (typeof s !== 'string' || !WEEK_RE.test(s)) return false;
  const w = Number(s.slice(6));
  return w >= 1 && w <= 53;
}

// ---------- 应用 ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// 存活探针：故意放在鉴权之前，只回 uptime，不含任何数据
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

app.use((req, res, next) => {
  if (AUTH_OFF) return next();
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i > 0 && safeEqual(raw.slice(0, i), AUTH_USER) && safeEqual(raw.slice(i + 1), AUTH_PASS)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="workbench", charset="UTF-8"');
  res.status(401).type('text/plain; charset=utf-8').send('需要登录');
});

app.get('/api/items', (req, res) => {
  const { from, to, week } = req.query;
  if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'from/to 需为 YYYY-MM-DD' });
  if (from > to) return res.status(400).json({ error: 'from 不能晚于 to' });
  if (week !== undefined && !isWeek(week)) return res.status(400).json({ error: 'week 需为 YYYY-Www' });

  const db = store.load();
  const items = db.items.filter((it) => it.date >= from && it.date <= to).sort(compareArrangements);

  // 周规划跟着这一趟顺路回来：多一个可选字段，比再发一次请求少一个往返。
  // 没传 week 或那一周没规划，响应里就没有 plan 这个键（稀疏，不铺空数组）
  const body = week === undefined ? { items } : withPlan(db, week, items);

  // 带 ETag：翻回上一周（数据没变）时直接 304，响应体为空。
  // 移动端每次翻周都要过一次跨境往返，省掉响应体能少几百字节的传输
  const text = JSON.stringify(body);
  const etag = 'W/"' + crypto.createHash('sha1').update(text).digest('base64url') + '"';
  res.set('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.type('application/json').send(text);
});

// 把某一周的规划挂进 items 响应。plans 在磁盘上是一条条记录，这里按 week 筛
function withPlan(db, week, items) {
  const plan = db.plans.filter((p) => p.week === week).sort(byOrder);
  const out = { items };
  if (plan.length) out.plan = plan;
  return out;
}

app.post('/api/items', (req, res) => {
  const b = req.body || {};
  const title = cleanText(b.title, 80);
  if (!isDate(b.date)) return res.status(400).json({ error: 'date 非法' });
  if (!SLOTS.includes(b.slot)) return res.status(400).json({ error: 'slot 非法' });
  if (!title) return res.status(400).json({ error: '标题不能为空' });

  const db = store.load();
  const key = groupKey(b);
  const siblings = db.items.filter((it) => groupKey(it) === key);
  const item = {
    id: crypto.randomUUID(),
    date: b.date,
    slot: b.slot,
    title,
    note: cleanText(b.note, 500),
    order: siblings.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const next = store.envelope(db.items.concat(item), db.plans);
  normalizeOrder(next.items);
  store.save(next);
  res.status(201).json({ item });
});

app.patch('/api/items/:id', (req, res) => {
  const db = store.load();
  const item = db.items.find((it) => it.id === req.params.id);
  if (!item) return res.status(404).json({ error: '不存在' });

  const b = req.body || {};
  if (b.date !== undefined && !isDate(b.date)) return res.status(400).json({ error: 'date 非法' });
  if (b.slot !== undefined && !SLOTS.includes(b.slot)) return res.status(400).json({ error: 'slot 非法' });
  if (b.title !== undefined && !cleanText(b.title, 80)) return res.status(400).json({ error: '标题不能为空' });
  if (b.done !== undefined && typeof b.done !== 'boolean') return res.status(400).json({ error: 'done 需为布尔值' });

  if (b.title !== undefined) item.title = cleanText(b.title, 80);
  if (b.note !== undefined) item.note = cleanText(b.note, 500);
  if (b.slot !== undefined) item.slot = b.slot;
  if (b.date !== undefined) item.date = b.date;
  // 完成只是一个时间戳：有就是已完成，没有就是未完成（不写 done:false，接口响应保持原样）
  if (b.done === true && !item.doneAt) item.doneAt = new Date().toISOString();
  if (b.done === false) delete item.doneAt;
  item.updatedAt = new Date().toISOString();

  const next = store.envelope(db.items, db.plans);
  normalizeOrder(next.items);
  store.save(next);
  res.json({ item });
});

app.delete('/api/items/:id', (req, res) => {
  const db = store.load();
  const idx = db.items.findIndex((it) => it.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '不存在' });
  const items = db.items.slice();
  items.splice(idx, 1);
  const next = store.envelope(items, db.plans);
  normalizeOrder(next.items);
  store.save(next);
  res.json({ ok: true });
});

app.post('/api/items/:id/move', (req, res) => {
  const dir = (req.body || {}).dir;
  if (dir !== 'up' && dir !== 'down') return res.status(400).json({ error: 'dir 需为 up 或 down' });

  const db = store.load();
  const item = db.items.find((it) => it.id === req.params.id);
  if (!item) return res.status(404).json({ error: '不存在' });

  const siblings = db.items
    .filter((it) => groupKey(it) === groupKey(item))
    .sort(byOrder);
  const i = siblings.indexOf(item);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= siblings.length) return res.json({ item, moved: false });

  const other = siblings[j];
  const tmp = item.order;
  item.order = other.order;
  other.order = tmp;

  const next = store.envelope(db.items, db.plans);
  normalizeOrder(next.items);
  store.save(next);
  res.json({ item, moved: true });
});

// 落位：拖拽松手时一次说清「哪天 / 哪一段 / 第几位」，服务端不再猜。
// 时段由落点决定，所以这里允许跨段；界面只负责把落点画清楚。
app.post('/api/items/:id/place', (req, res) => {
  const b = req.body || {};
  if (!isDate(b.date)) return res.status(400).json({ error: 'date 非法' });
  if (!SLOTS.includes(b.slot)) return res.status(400).json({ error: 'slot 非法' });
  if (!Number.isInteger(b.index) || b.index < 0) return res.status(400).json({ error: 'index 需为非负整数' });

  const db = store.load();
  if (!db.items.some((it) => it.id === req.params.id)) return res.status(404).json({ error: '不存在' });

  const next = store.envelope(db.items, db.plans);
  placeItem(next.items, req.params.id, b.date, b.slot, b.index);
  const item = next.items.find((it) => it.id === req.params.id);
  item.updatedAt = new Date().toISOString();
  store.save(next);
  res.json({ item });
});

/* ---------- 周规划 ----------
   一条规划也是一条记录：{ id, week, title, note?, doneAt?, order, createdAt, updatedAt }。
   与「安排」同形但不同表 —— 规划不落位、不挂时段，只归属到某一周。
   界面读规划走 GET /api/items 顺路带回（少一个往返）；这个 GET 留着给自检与排查用。 */

// 取某一周的规划
app.get('/api/plan', (req, res) => {
  const { week } = req.query;
  if (!isWeek(week)) return res.status(400).json({ error: 'week 需为 YYYY-Www' });
  res.json({ plan: store.load().plans.filter((p) => p.week === week).sort(byOrder) });
});

// 加一条规划条目
app.post('/api/plan', (req, res) => {
  const b = req.body || {};
  if (!isWeek(b.week)) return res.status(400).json({ error: 'week 需为 YYYY-Www' });
  const title = cleanText(b.title, 80);
  if (!title) return res.status(400).json({ error: '标题不能为空' });

  const db = store.load();
  const siblings = db.plans.filter((p) => p.week === b.week);
  const now = new Date().toISOString();
  const plan = {
    id: crypto.randomUUID(),
    week: b.week,
    title,
    order: siblings.length,
    createdAt: now,
    updatedAt: now,
  };
  const note = cleanNote(b.note, 200);
  if (note) plan.note = note;   // 没有备注就不写这个字段
  // 建的时候就能带完成状态：前端新增后立刻勾选，不该等下一次 PATCH
  if (b.done === true) plan.doneAt = now;

  const next = store.envelope(db.items, db.plans.concat(plan));
  store.save(next);
  res.status(201).json({ plan });
});

// 改一条规划：标题 / 备注 / 完成。字段不存在就不动它
app.patch('/api/plan/:id', (req, res) => {
  const db = store.load();
  const plan = db.plans.find((p) => p.id === req.params.id);
  // 对象不存在就不谈字段：404 先于校验
  if (!plan) return res.status(404).json({ error: '不存在' });

  const b = req.body || {};
  if (b.title !== undefined && !cleanText(b.title, 80)) return res.status(400).json({ error: '标题不能为空' });
  if (b.done !== undefined && typeof b.done !== 'boolean') return res.status(400).json({ error: 'done 需为布尔值' });

  if (b.title !== undefined) plan.title = cleanText(b.title, 80);
  if (b.note !== undefined) {
    const note = cleanNote(b.note, 200);
    // 备注清空就把字段删掉，别留一个空串占着
    if (note) plan.note = note;
    else delete plan.note;
  }
  // 完成只是一个时间戳：有就是已完成，没有就是未完成（同 ADR-0007）
  if (b.done === true && !plan.doneAt) plan.doneAt = new Date().toISOString();
  if (b.done === false) delete plan.doneAt;
  plan.updatedAt = new Date().toISOString();

  store.save(store.envelope(db.items, db.plans));
  res.json({ plan });
});

app.delete('/api/plan/:id', (req, res) => {
  const db = store.load();
  const idx = db.plans.findIndex((p) => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '不存在' });
  const plans = db.plans.slice();
  plans.splice(idx, 1);
  store.save(store.envelope(db.items, plans));
  res.json({ ok: true });
});

app.get('/api/export', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="workbench-data.json"');
  // 导出的就是磁盘格式本身（空 plans 不写），能原样放回 DATA_DIR
  res.json(store.forDisk(store.load()));
});

// 领域模块：浏览器要的那一份（与服务端 require 的是同一个文件）
app.get('/domain.js', (req, res) => res.sendFile(path.join(__dirname, 'lib', 'domain.js')));

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html'],
  setHeaders(res, filePath) {
    // 文件名里没有内容指纹，所以不能上 immutable —— 那会把旧版钉死在浏览器缓存里。
    // 给一小时并要求回源校验：重复访问直接吃本地缓存，发版后仍能拿到新版。
    if (/\.(css|js|svg|png|jpe?g|gif|ico|webp|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  },
}));

app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('404'));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON 格式错误' });
  console.error('[error]', err && err.message);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[workbench] listening on :${PORT}, data=${store.DATA_FILE}, auth=${AUTH_OFF ? 'OFF' : 'basic'}`);
});
