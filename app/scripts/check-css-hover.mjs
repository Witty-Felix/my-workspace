#!/usr/bin/env node
// 悬停只能写在 @media (hover:hover) 里。
// 触屏没有 hover，浏览器却会在手指按下时套用 :hover 并一直留着 ——
// 点一下卡片就浮着不落，点下一个才弹回去。这类问题肉眼难查，交给这里。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'public', 'style.css');
const src = fs.readFileSync(FILE, 'utf8');

// 注释按字符换成空格，保留换行，行号才不会错位
const bare = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const stack = [];
const bad = [];
let total = 0;
let buf = '';
let line = 1;
let start = 1;

for (let i = 0; i < bare.length; i++) {
  const ch = bare[i];
  if (ch === '\n') { line++; buf += ch; continue; }

  if (ch === '{') {
    const head = buf.trim();
    buf = '';
    if (head.startsWith('@')) {
      stack.push(head);
      continue;
    }
    const guarded = stack.some((s) => /hover\s*:\s*hover/.test(s));
    if (/:hover\b/.test(head)) {
      total++;
      if (!guarded) bad.push({ sel: head, line: start });
    }
    stack.push('rule');
    continue;
  }

  if (ch === '}') { stack.pop(); buf = ''; continue; }

  if (ch === ';' && stack[stack.length - 1] === 'rule') { buf = ''; continue; }

  if (!buf.trim() && /\S/.test(ch)) start = line;
  buf += ch;
}

if (bad.length) {
  console.error('  ✗ 有 :hover 没包在 @media (hover:hover) 里：');
  for (const b of bad) console.error(`      style.css:${b.line}  ${b.sel}`);
  process.exit(1);
}
console.log(`  ✓ 悬停样式全部包在 @media (hover:hover) 里（${total} 条）`);
