'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const BAK_FILE = path.join(DATA_DIR, 'data.json.bak');
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
// AUTH=off 显式关闭登录：默认仍是 basic，避免误删凭据就把站点裸奔出去
const AUTH_OFF = String(process.env.AUTH || 'basic').toLowerCase() === 'off';
const SLOTS = ['am', 'pm', 'eve'];

if (!AUTH_OFF && (!AUTH_USER || !AUTH_PASS)) {
  console.error('[fatal] AUTH_USER / AUTH_PASS 未设置，拒绝启动（fail-closed）。确需免登录请设 AUTH=off');
  process.exit(1);
}

// ---------- 存储：单文件 JSON，原子替换 + 一步备份 ----------

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = { version: 1, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[store] 读取失败，按空库启动：', err.message);
    cache = { version: 1, items: [] };
  }
  return cache;
}

function save(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE);
  fs.renameSync(tmp, DATA_FILE);
  cache = next;
}

function bySortOrder(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const sa = SLOTS.indexOf(a.slot);
  const sb = SLOTS.indexOf(b.slot);
  if (sa !== sb) return sa - sb;
  return (a.order || 0) - (b.order || 0);
}

function normalizeOrder(items) {
  const groups = new Map();
  for (const it of items) {
    const k = it.date + '|' + it.slot;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.order || 0) - (b.order || 0));
    list.forEach((it, i) => { it.order = i; });
  }
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
  const items = load().items.filter((it) => it.date >= from && it.date <= to).sort(bySortOrder);
  res.json({ items });
});

app.post('/api/items', (req, res) => {
  const b = req.body || {};
  const title = cleanText(b.title, 80);
  if (!isDate(b.date)) return res.status(400).json({ error: 'date 非法' });
  if (!SLOTS.includes(b.slot)) return res.status(400).json({ error: 'slot 非法' });
  if (!title) return res.status(400).json({ error: '标题不能为空' });

  const db = load();
  const siblings = db.items.filter((it) => it.date === b.date && it.slot === b.slot);
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
  const next = { version: 1, items: db.items.concat(item) };
  normalizeOrder(next.items);
  save(next);
  res.status(201).json({ item });
});

app.patch('/api/items/:id', (req, res) => {
  const db = load();
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

  const next = { version: 1, items: db.items };
  normalizeOrder(next.items);
  save(next);
  res.json({ item });
});

app.delete('/api/items/:id', (req, res) => {
  const db = load();
  const idx = db.items.findIndex((it) => it.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '不存在' });
  const items = db.items.slice();
  items.splice(idx, 1);
  const next = { version: 1, items };
  normalizeOrder(next.items);
  save(next);
  res.json({ ok: true });
});

app.post('/api/items/:id/move', (req, res) => {
  const dir = (req.body || {}).dir;
  if (dir !== 'up' && dir !== 'down') return res.status(400).json({ error: 'dir 需为 up 或 down' });

  const db = load();
  const item = db.items.find((it) => it.id === req.params.id);
  if (!item) return res.status(404).json({ error: '不存在' });

  const siblings = db.items
    .filter((it) => it.date === item.date && it.slot === item.slot)
    .sort((a, b) => a.order - b.order);
  const i = siblings.indexOf(item);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= siblings.length) return res.json({ item, moved: false });

  const other = siblings[j];
  const tmp = item.order;
  item.order = other.order;
  other.order = tmp;

  const next = { version: 1, items: db.items };
  normalizeOrder(next.items);
  save(next);
  res.json({ item, moved: true });
});

app.get('/api/export', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="workbench-data.json"');
  res.json(load());
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: ['html'] }));

app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('404'));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON 格式错误' });
  console.error('[error]', err && err.message);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[workbench] listening on :${PORT}, data=${DATA_FILE}, auth=${AUTH_OFF ? 'OFF' : 'basic'}`);
});
