'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
// 领域常量与排序规则：与浏览器共用同一份（app/lib/domain.js）
const { SLOTS, compareArrangements, groupKey, byOrder, normalizeOrder } = require('./lib/domain');
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
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'from/to 需为 YYYY-MM-DD' });
  if (from > to) return res.status(400).json({ error: 'from 不能晚于 to' });
  const items = store.load().items.filter((it) => it.date >= from && it.date <= to).sort(compareArrangements);
  // 带 ETag：翻回上一周（数据没变）时直接 304，响应体为空。
  // 移动端每次翻周都要过一次跨境往返，省掉响应体能少几百字节的传输
  const body = JSON.stringify({ items });
  const etag = 'W/"' + crypto.createHash('sha1').update(body).digest('base64url') + '"';
  res.set('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.type('application/json').send(body);
});

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
  const next = store.envelope(db.items.concat(item));
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

  if (b.title !== undefined) item.title = cleanText(b.title, 80);
  if (b.note !== undefined) item.note = cleanText(b.note, 500);
  if (b.slot !== undefined) item.slot = b.slot;
  if (b.date !== undefined) item.date = b.date;
  item.updatedAt = new Date().toISOString();

  const next = store.envelope(db.items);
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
  const next = store.envelope(items);
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

  const next = store.envelope(db.items);
  normalizeOrder(next.items);
  store.save(next);
  res.json({ item, moved: true });
});

app.get('/api/export', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="workbench-data.json"');
  res.json(store.load());
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
