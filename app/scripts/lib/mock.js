'use strict';
// 假服务：给 /api/items 注入一次（或持续）500，用来验证前端的自动重试。
// 用法：node mock.js <端口> <once|always> <上游端口>
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 8183);
const mode = process.argv[3] || 'once';
const upstream = Number(process.argv[4] || 8182);
const APP = path.join(__dirname, '..', '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

let hits = 0;

http.createServer((req, res) => {
  const p = req.url.split('?')[0];

  if (p === '/hits') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(String(hits));
    return;
  }

  if (p.startsWith('/api/items')) {
    hits += 1;
    if (mode === 'always' || hits === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"模拟 500"}');
      return;
    }
    const proxy = http.request({ host: '127.0.0.1', port: upstream, path: req.url, method: req.method }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    req.pipe(proxy);
    return;
  }

  // 领域模块与静态资源
  const file = p === '/domain.js'
    ? path.join(APP, 'lib', 'domain.js')
    : path.join(APP, 'public', p === '/' ? 'index.html' : p);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}).listen(port, () => console.log(`mock :${port} mode=${mode} upstream=${upstream}`));
