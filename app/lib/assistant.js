/* 助手：把一句口语变成「往工作台写什么」的草案。
   只出草案，不落库 —— 落库永远由用户点「写入」之后走 REST 那条路。
   模型只要 AI_KEY 一个秘密；没有就 503，不静默降级成假数据。

   为什么由服务端持有 key：浏览器里的 key 等于公开。同理也不把模型原始回复
   直接交给前端拼 HTML —— 出来的东西一律当数据，逐条校验后才进草案。 */
'use strict';

const { SLOTS } = require('./domain');

const BASE = (process.env.AI_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const KEY = process.env.AI_KEY || '';
const MODEL = process.env.AI_MODEL || 'deepseek-chat';
const TIMEOUT = Number(process.env.AI_TIMEOUT || 30000);

const MAX_MSGS = 20;
const MAX_LEN = 2000;
const MAX_ENTRIES = 20;
// 模型编日期时容易离谱：只认今天前后 120 天内的
const MAX_DRIFT_DAYS = 120;

const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const SLOT_LABELS = { am: '上午', pm: '下午', eve: '晚上' };

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const md = (d) => `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
const addDays = (d, n) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
};

function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

// 与 public/app.js 的 isoWeek 同一算法：界面上显示的周标识必须对得上
function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const week1 = new Date(t.getFullYear(), 0, 4);
  const w = 1 + Math.round(((t - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${t.getFullYear()}-W${pad2(w)}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;

function realDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function realWeek(s) {
  if (typeof s !== 'string' || !WEEK_RE.test(s)) return false;
  const w = Number(s.slice(6));
  return w >= 1 && w <= 53;
}

// 与 server.js 的 cleanText 同规则：压平空白再截断。两份必须一致，
// 否则草案里显示的标题写完会变样
function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanNote(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim().slice(0, max);
}

/* 把两周的日期摊成表给模型看。
   这是解析「下周三」最省事也最准的办法：不让它做算术，只让它查表。 */
function calendar(now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisMon = startOfWeek(today);
  const nextMon = addDays(thisMon, 7);
  const line = (start, label) => {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      days.push(`${DOW[i]} ${ymd(d)}`);
    }
    return `${label}（${isoWeek(start)}）：${days.join('、')}`;
  };
  return [
    `今天：${ymd(today)}（${DOW[(today.getDay() + 6) % 7]}），本周 ${isoWeek(today)}`,
    line(thisMon, '本周'),
    line(nextMon, '下周'),
    line(addDays(thisMon, -7), '上周'),
  ].join('\n');
}

function systemPrompt(now) {
  return `你是「周工作台」里的助手。用户用口语说事情，你把它变成能直接写进工作台的条目。

${calendar(now)}

你只能做两件事：
1. 往某一天的某个时段加一条「安排」
2. 往某一周加一条「周规划」

限制（必须遵守）：
- 不能修改或删除已有条目，只能新增。
- 「安排」用 items，字段：date（YYYY-MM-DD，必须来自上面那张表的日期）、slot（只能是 am / pm / eve）、title（≤80 字）、note（可选，≤500 字）。
- 「周规划」用 plans，字段：week（YYYY-Www，如 2026-W46）、title（≤80 字）、note（可选，≤200 字，可换行）。
- **只要话里落到了某一天（「周三前」「周四」「明天」），就必须写 items**，不许把日期塞进标题或备注。
- 只有整句都停留在「这一周」层面、没有任何一天时，才写 plans。两者都要时同时给，各管各的。
- 同一次输入里，「某周重点推进 X」这种整周层面的诉求写 plans，「周几要做 Y」写 items —— 不要为了省事把它压成一条。
- 「X 前」= 在那个日期当天或之前做完，就写在那个日期，不要往前挪。
- 时段：早上/上午/一早 → am；下午/中午后 → pm；晚上/夜里 → eve。完全没提就按 am。
- note 只放补充信息（跟谁、在哪、注意什么），不要把标题换个说法重写一遍。
- 一句话里有多件事就拆成多条，一件事不要拆。不要把「①②③」里的分条当成多件事。
- 用户只是闲聊、提问、或者没给任何可写内容时，draft 给空数组，不要硬造条目。

只输出 JSON，不要任何解释文字、不要代码围栏：
{"reply":"给用户的一句话回执，中文，简短，别复述条目","draft":{"plans":[],"items":[]}}`;
}

/* 模型的 JSON 回复不保证干净：可能带围栏、可能前后有废话。
   截取第一个 { 到最后一个 } 之间再解析 —— 比正则剥围栏更耐操。 */
function parseJson(text) {
  if (typeof text !== 'string') return null;
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(text.slice(i, j + 1));
  } catch (_) {
    return null;
  }
}

/* 逐条校验草案。模型给什么都不能直接信：
   日期可能是编的、slot 可能是中文、title 可能超长。
   丢掉的条目不静默吞掉，计数回给前端，好在回执里说清楚。 */
function normalizeDraft(raw, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = { plans: [], items: [] };
  let dropped = 0;

  const src = raw && typeof raw === 'object' ? raw : {};
  const plans = Array.isArray(src.plans) ? src.plans : [];
  const items = Array.isArray(src.items) ? src.items : [];

  for (const p of plans) {
    if (out.plans.length >= MAX_ENTRIES) { dropped++; continue; }
    const title = cleanText(p && p.title, 80);
    if (!title || !realWeek(p && p.week)) { dropped++; continue; }
    const entry = { week: p.week, title };
    const note = cleanNote(p.note, 200);
    if (note) entry.note = note;
    out.plans.push(entry);
  }

  for (const it of items) {
    if (out.items.length >= MAX_ENTRIES) { dropped++; continue; }
    const title = cleanText(it && it.title, 80);
    if (!title || !realDate(it && it.date) || !SLOTS.includes(it && it.slot)) { dropped++; continue; }
    // 编到 2019 年或者三年后的日期，写进去用户根本找不到
    const drift = Math.abs((new Date(it.date + 'T00:00:00Z') - new Date(ymd(today) + 'T00:00:00Z')) / 86400000);
    if (drift > MAX_DRIFT_DAYS) { dropped++; continue; }
    const entry = { date: it.date, slot: it.slot, title };
    const note = cleanText(it.note, 500);
    if (note) entry.note = note;
    out.items.push(entry);
  }

  return { draft: out, dropped };
}

// 消息只收 user / assistant，且限条数与长度：这条路由是唯一会把钱花出去的地方
function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_MSGS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_LEN) }))
    .filter((m) => m.content.trim());
}

class AssistantError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function ask(messages, now = new Date()) {
  if (!KEY) {
    throw new AssistantError('助手还没配置模型密钥：在 app/.env 里写 AI_KEY 后重启服务', 503);
  }
  const msgs = normalizeMessages(messages);
  if (!msgs.length) throw new AssistantError('没有要处理的内容', 400);
  if (msgs[msgs.length - 1].role !== 'user') throw new AssistantError('最后一条需要是用户的话', 400);

  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemPrompt(now) }, ...msgs],
        temperature: 0.2,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new AssistantError(timeout ? '模型响应超时，稍后再试' : '连不上模型服务，检查网络或 AI_BASE', 504);
  }

  if (!res.ok) {
    // 上游的报错正文可能带 key 片段与内部地址，不回给浏览器
    const detail = await res.text().catch(() => '');
    console.error('[assistant] 上游', res.status, detail.slice(0, 300));
    const hint = res.status === 401 || res.status === 403 ? 'AI_KEY 无效或没有该模型权限' : `模型服务返回 ${res.status}`;
    throw new AssistantError(hint, 502);
  }

  const body = await res.json().catch(() => null);
  const text = body && body.choices && body.choices[0] && body.choices[0].message
    ? body.choices[0].message.content
    : '';
  const parsed = parseJson(text);

  if (!parsed) {
    // 模型答非所问时不假装成功：把它的原话当作回执，草案留空
    const fallback = cleanText(text, 300) || '模型没有给出可用的答复';
    return { reply: fallback, draft: { plans: [], items: [] }, dropped: 0, model: MODEL };
  }

  const { draft, dropped } = normalizeDraft(parsed.draft, now);
  let reply = cleanText(parsed.reply, 300);
  const total = draft.plans.length + draft.items.length;
  if (!reply) {
    reply = total ? `理出 ${total} 条，确认后写进去。` : '这条没听出要写什么，再说具体点？';
  }

  return { reply, draft, dropped, model: MODEL };
}

module.exports = { ask, AssistantError, calendar, normalizeDraft, normalizeMessages };
