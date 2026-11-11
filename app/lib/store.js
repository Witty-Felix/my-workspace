/* 存储层：安排与周规划怎么落盘、怎么读回。只管这一件事。
   磁盘格式固定为 { version, items, plans? } —— 这是回滚安全的唯一依据，
   改动字段名或版本号必须同时写迁移。
   plans 与 items 同形：一条规划也是一条记录，靠 week 字段归属到某一周。
   没有规划时整个字段不写，所以只加它不算改版本，老数据读出来就是空。 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const BAK_FILE = path.join(DATA_DIR, 'data.json.bak');
const CURRENT_VERSION = 1;

let cache = null;

// 存储信封：全库只有这一处构造。
// 内存里 plans 始终是数组（调用方不用判空）；写盘时才把空的省掉 —— 稀疏的是磁盘格式
function envelope(items, plans) {
  return { version: CURRENT_VERSION, items, plans: Array.isArray(plans) ? plans : [] };
}

// 写盘用的副本：空 plans 不落盘，老版本读回来也不会多一个空数组
function forDisk(env) {
  const out = { version: env.version, items: env.items };
  if (Array.isArray(env.plans) && env.plans.length) out.plans = env.plans;
  return out;
}

// 读库。返回的是同一个缓存引用 —— 调用方会就地改对象，别改成深拷贝
function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed.version > CURRENT_VERSION) {
      console.warn(`[store] 数据版本 ${parsed.version} 高于当前 ${CURRENT_VERSION}，按 v${CURRENT_VERSION} 读取`);
    }
    cache = envelope(
      Array.isArray(parsed.items) ? parsed.items : [],
      Array.isArray(parsed.plans) ? parsed.plans : []
    );
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[store] 读取失败，按空库启动：', err.message);
    cache = envelope([]);
  }
  return cache;
}

// 写库：先写临时文件再原子替换，旧文件留一份 .bak
function save(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(forDisk(next), null, 2), 'utf8');
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE);
  fs.renameSync(tmp, DATA_FILE);
  cache = next;
}

module.exports = { DATA_FILE, BAK_FILE, CURRENT_VERSION, envelope, forDisk, load, save };
