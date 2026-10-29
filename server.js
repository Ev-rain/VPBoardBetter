#!/usr/bin/env node
/* ============================================================
   server.js — 本地启动器（零依赖）
   1) 静态托管本目录（index.html + assets + fixtures）
   2) /api/health            启动器自检
   3) /api/proxy?url=…       白名单 CORS 代理（board.xcpcio.com / xcpcio.github.io）
   4) /api/qoj/*             用本机 Edge + DevTools 协议驱动 QOJ（绕过 Cloudflare 人机验证）
   只监听 127.0.0.1。
   ============================================================ */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const cdp = require('./qoj-cdp.js');
const path = require('path');
const { execFile } = require('child_process');
const { URL, URLSearchParams } = require('url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const QOJ_ORIGIN = 'https://qoj.ac';
const PROXY_HOSTS = new Set(['board.xcpcio.com', 'xcpcio.github.io']);
const MAX_PROXY_BYTES = 30 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function log(...args) {
  console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ']', ...args);
}

/* ---------------- 通用 HTTP 客户端（带 cookie 罐） ---------------- */

const cookieJar = new Map(); // host -> Map(name -> value)

function jarFor(hostname) {
  if (!cookieJar.has(hostname)) cookieJar.set(hostname, new Map());
  return cookieJar.get(hostname);
}

function storeCookies(hostname, setCookie) {
  if (!setCookie) return;
  const jar = jarFor(hostname);
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

function cookieHeader(hostname) {
  const jar = jarFor(hostname);
  if (!jar.size) return '';
  return Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ');
}

function rawRequest(method, urlStr, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('非法 URL: ' + urlStr)); }
    const body = opts.body == null ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8');
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }, opts.headers || {});
    const ck = cookieHeader(u.hostname);
    if (ck) headers['Cookie'] = ck;
    if (body) {
      headers['Content-Length'] = body.length;
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, headers, timeout: opts.timeout || 20000
    }, (res) => {
      storeCookies(u.hostname, res.headers['set-cookie']);
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > (opts.maxBytes || MAX_PROXY_BYTES)) { req.destroy(new Error('响应过大')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), url: urlStr });
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 手动跟随重定向，保留 cookie */
async function fetchPage(urlStr, opts) {
  opts = opts || {};
  let current = urlStr;
  for (let i = 0; i < 6; i++) {
    const r = await rawRequest(opts.method || 'GET', current, opts);
    if (r.status === 403 && /Just a moment|challenge-platform|cf-challenge/i.test(r.body)) {
      throw new Error('QOJ 被 Cloudflare 人机验证拦截（cf-ray: ' + (r.headers['cf-ray'] || '?') + '），纯 HTTP 请求过不去；请用浏览器完成验证，或先用手动「记录提交」');
    }
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      current = new URL(r.headers.location, current).toString();
      opts = Object.assign({}, opts, { method: 'GET', body: null, headers: Object.assign({}, opts.headers, { 'Content-Type': undefined }) });
      continue;
    }
    return r;
  }
  throw new Error('重定向次数过多');
}

/* ---------------- 榜单列表（XCPCIO 仓库 → 可搜索的比赛清单） ---------------- */

const BOARD_CACHE_FILE = path.join(ROOT, '_boards.cache.json');
const BOARD_TTL_MS = 6 * 60 * 60 * 1000;
let boardCache = { ts: 0, list: [] };

async function fetchJsonShort(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'vp-board-better' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function buildBoardIndex() {
  const tree = await fetchJsonShort('https://api.github.com/repos/xcpcio/board-data/git/trees/main?recursive=1', 30000);
  const paths = [];
  (tree.tree || []).forEach((x) => {
    const m = /^data\/(.+)\/config\.json$/.exec(x.path || '');
    if (m) paths.push(m[1]);
  });
  if (!paths.length) throw new Error('仓库里没有找到 config.json');
  const list = paths.map((p) => ({ p: p, n: '', t: '' }));
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const item = list[cursor++];
      for (const host of ['https://board.xcpcio.com/data/', 'https://xcpcio.github.io/board-data/data/']) {
        try {
          const cfg = await fetchJsonShort(host + item.p + '/config.json', 12000);
          item.n = String(cfg.contest_name || cfg.name || '').trim();
          const st = Number(cfg.start_time || cfg.startTime || 0);
          if (st > 1e9) item.t = new Date(st < 1e12 ? st * 1000 : st).toISOString().slice(0, 10);
          break;
        } catch (e) { /* 换下一个数据源 */ }
      }
    }
  };
  await Promise.all(new Array(12).fill(0).map(worker));
  list.sort((a, b) => (b.t || '').localeCompare(a.t || '') || a.p.localeCompare(b.p));
  return list;
}

async function boardIndex(force) {
  const now = Date.now();
  if (!force && boardCache.list.length && now - boardCache.ts < BOARD_TTL_MS) return boardCache;
  try {
    const list = await buildBoardIndex();
    boardCache = { ts: now, list: list };
    try { fs.writeFileSync(BOARD_CACHE_FILE, JSON.stringify(boardCache)); } catch (e) { /* 缓存写不了就算了 */ }
    return boardCache;
  } catch (e) {
    if (boardCache.list.length) return boardCache;
    try {
      const raw = JSON.parse(fs.readFileSync(BOARD_CACHE_FILE, 'utf8'));
      if (raw && raw.list && raw.list.length) { boardCache = raw; return raw; }
    } catch (e2) { /* ignore */ }
    throw e;
  }
}

/* ---------------- 极简 HTML 解析 ---------------- */

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase();
    attrs[name] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
  }
  return attrs;
}

function parseForms(html) {
  const forms = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = parseAttrs(m[1]);
    const inner = m[2];
    const fields = [];
    let im;
    const inputRe = /<input\b([^>]*?)\/?>/gi;
    while ((im = inputRe.exec(inner))) {
      const a = parseAttrs(im[1]);
      if (!a.name) continue;
      fields.push({ tag: 'input', name: a.name, type: (a.type || 'text').toLowerCase(), value: a.value != null ? a.value : '', checked: 'checked' in a });
    }
    const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
    while ((im = taRe.exec(inner))) {
      const a = parseAttrs(im[1]);
      if (!a.name) continue;
      fields.push({ tag: 'textarea', name: a.name, type: 'textarea', value: im[2] });
    }
    const selRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    while ((im = selRe.exec(inner))) {
      const a = parseAttrs(im[1]);
      if (!a.name) continue;
      const options = [];
      let om;
      const optRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
      while ((om = optRe.exec(im[2]))) {
        const oa = parseAttrs(om[1]);
        options.push({ value: oa.value != null ? oa.value : stripTags(om[2]).trim(), text: stripTags(om[2]).trim(), selected: 'selected' in oa });
      }
      fields.push({ tag: 'select', name: a.name, type: 'select', options, value: (options.find(o => o.selected) || options[0] || {}).value || '' });
    }
    const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    while ((im = btnRe.exec(inner))) {
      const a = parseAttrs(im[1]);
      if (!a.name) continue;
      fields.push({ tag: 'button', name: a.name, type: (a.type || 'submit').toLowerCase(), value: a.value != null ? a.value : stripTags(im[2]).trim() });
    }
    forms.push({
      attrs,
      action: attrs.action || '',
      method: (attrs.method || 'get').toLowerCase(),
      fields
    });
  }
  return forms;
}

function stripTags(s) {
  return String(s).replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function findForm(forms, pred) {
  for (const f of forms) if (pred(f)) return f;
  return null;
}

function buildFormBody(form, overrides) {
  const params = new URLSearchParams();
  for (const f of form.fields) {
    if (f.tag === 'button') continue;
    if (f.type === 'checkbox' || f.type === 'radio') {
      if (f.checked) params.append(f.name, f.value);
      continue;
    }
    if (f.tag === 'select') { params.append(f.name, f.value || ''); continue; }
    params.append(f.name, overrides && Object.prototype.hasOwnProperty.call(overrides, f.name) ? overrides[f.name] : f.value || '');
  }
  for (const b of form.fields) {
    if (b.tag === 'button' && b.type === 'submit' && b.name) params.append(b.name, b.value || '');
  }
  return params.toString();
}

/* ---------------- QOJ 会话 ---------------- */

const qoj = {
  loggedIn: false,
  user: '',
  languages: [],
  lastError: '',
  debug: []
};

function qojDbg(line) {
  qoj.debug.push(line);
  if (qoj.debug.length > 120) qoj.debug.shift();
  log('[qoj]', line);
}

function verdictFromText(text) {
  const t = text || '';
  const table = [
    ['Accepted', 'Accepted'],
    ['Wrong Answer', 'Wrong Answer'],
    ['Time Limit Exceeded', 'Time Limit Exceeded'],
    ['Memory Limit Exceeded', 'Memory Limit Exceeded'],
    ['Runtime Error', 'Runtime Error'],
    ['Compilation Error', 'Compilation Error'],
    ['Compile Error', 'Compilation Error'],
    ['Presentation Error', 'Presentation Error'],
    ['Output Limit Exceeded', 'Output Limit Exceeded'],
    ['Idleness Limit Exceeded', 'Idleness Limit Exceeded'],
    ['Judgement Failed', 'Judgement Failed'],
    ['Judge Failed', 'Judgement Failed'],
    ['System Error', 'System Error'],
    ['Waiting', 'Waiting'],
    ['Queued', 'Waiting'],
    ['Pending', 'Waiting'],
    ['Compiling', 'Compiling'],
    ['Running', 'Running'],
    ['Judging', 'Judging']
  ];
  for (const [needle, verdict] of table) {
    if (t.includes(needle)) return verdict;
  }
  return '';
}

async function qojLogin(username, password) {
  qoj.debug = [];
  const page = await fetchPage(QOJ_ORIGIN + '/login');
  qojDbg('GET /login -> ' + page.status + ' (' + page.body.length + 'B)');
  const forms = parseForms(page.body);
  qojDbg('发现 ' + forms.length + ' 个表单');
  const form = findForm(forms, f => f.fields.some(x => x.type === 'password'));
  if (!form) {
    qoj.lastError = '登录页没有找到带密码框的表单';
    qojDbg(qoj.lastError);
    const snippet = stripTags(page.body).slice(0, 200);
    throw new Error(qoj.lastError + (snippet ? '（页面片段：' + snippet + '）' : ''));
  }
  const userField = form.fields.find(x => x.type !== 'password' && x.type !== 'hidden' && /user|name|login|email|id/i.test(x.name)) ||
    form.fields.find(x => x.type === 'text');
  const passField = form.fields.find(x => x.type === 'password');
  if (!userField || !passField) throw new Error('无法识别用户名/密码字段');
  const action = new URL(form.action || '/login', QOJ_ORIGIN + '/login').toString();
  qojDbg('POST ' + action + ' 字段: ' + userField.name + ' / ' + passField.name);
  const body = buildFormBody(form, { [userField.name]: username, [passField.name]: password });
  const res = await fetchPage(action, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': QOJ_ORIGIN + '/login' } });
  const text = stripTags(res.body);
  qojDbg('登录响应 ' + res.status + '，长度 ' + res.body.length);

  if (/wrong password|invalid|密码错误|用户名或密码|Login failed|error/i.test(text) && !/logout|退出|我的提交|My submissions/i.test(text)) {
    const err = (text.match(/(wrong password[^.]*|用户名或密码[^。]*|密码错误[^。]*|invalid[^.]*)/i) || [])[1];
    qoj.lastError = err || '登录失败';
    throw new Error(qoj.lastError);
  }
  const home = await fetchPage(QOJ_ORIGIN + '/');
  const homeText = stripTags(home.body);
  qoj.loggedIn = /logout|退出|Sign out/i.test(homeText) || !/type="password"/i.test(home.body);
  if (!qoj.loggedIn) throw new Error('登录后仍显示未登录状态');
  const m = home.body.match(/href="\/user\/profile\/([^"]+)"/) || home.body.match(/\/user\/profile\/([^"?]+)/);
  qoj.user = m ? decodeURIComponent(m[1]) : username;
  qoj.lastError = '';
  qojDbg('登录成功: ' + qoj.user);
  return { user: qoj.user };
}

async function qojLogout() {
  qoj.loggedIn = false;
  qoj.user = '';
  cookieJar.delete('qoj.ac');
  return { ok: true };
}

async function qojProblems(contestUrl) {
  const url = new URL(contestUrl, QOJ_ORIGIN).toString();
  qojDbg('GET ' + url);
  const page = await fetchPage(url);
  const html = page.body;
  qojDbg('比赛页 ' + page.status + '，长度 ' + html.length);
  const out = [];
  const seen = new Set();
  const linkRe = /<a\b[^>]*href="([^"]*\/problem\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const text = stripTags(m[3]).trim();
    const label = (text.match(/^[A-Z]\d?/) || [])[0] || '';
    out.push({ id, label: label || text.slice(0, 8), title: text });
  }
  if (!out.length) {
    const idRe = /\/problem\/(\d+)/g;
    let mm;
    while ((mm = idRe.exec(html))) {
      if (!seen.has(mm[1])) { seen.add(mm[1]); out.push({ id: mm[1], label: '', title: '' }); }
    }
  }
  out.sort((a, b) => Number(a.id) - Number(b.id));
  qojDbg('解析到 ' + out.length + ' 道题');
  return out.slice(0, 40);
}

async function qojSubmit({ problemId, language, code }) {
  if (!/^\d+$/.test(String(problemId || ''))) throw new Error('题目 ID 必须是数字');
  const problemUrl = QOJ_ORIGIN + '/problem/' + problemId;
  qojDbg('GET ' + problemUrl);
  const page = await fetchPage(problemUrl);
  const forms = parseForms(page.body);
  qojDbg('题面页 ' + page.status + '，' + forms.length + ' 个表单');
  const form = findForm(forms, f => f.fields.some(x => x.tag === 'textarea')) ||
    findForm(forms, f => f.fields.some(x => x.type === 'file'));
  if (!form) {
    qoj.lastError = '题面页没有找到提交表单';
    throw new Error(qoj.lastError);
  }
  const overrides = {};
  for (const f of form.fields) {
    if (f.tag === 'textarea') overrides[f.name] = code;
    if (f.tag === 'select' && /lang/i.test(f.name)) {
      const opt = f.options.find(o => o.value === language || o.text === language) ||
        f.options.find(o => o.text.toLowerCase().includes(String(language).toLowerCase())) || f.options[0];
      overrides[f.name] = opt ? opt.value : language;
      qojDbg('语言 ' + language + ' -> ' + (opt ? opt.text + '(' + opt.value + ')' : '原样提交'));
    }
  }
  const action = new URL(form.action || problemUrl, problemUrl).toString();
  const body = buildFormBody(form, overrides);
  qojDbg('POST ' + action + '，' + body.length + ' 字节');
  const res = await fetchPage(action, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': problemUrl } });
  qojDbg('提交响应 ' + res.status);
  const hay = res.body + '\n' + (res.headers.location || '');
  const idm = hay.match(/\/submission\/(\d+)/);
  if (!idm) {
    const text = stripTags(res.body).slice(0, 300);
    throw new Error('提交后没有找到 submission id（页面片段：' + text + '）');
  }
  return { submissionId: Number(idm[1]) };
}

async function qojSubmission(id) {
  const url = QOJ_ORIGIN + '/submission/' + encodeURIComponent(id);
  const page = await fetchPage(url);
  const text = stripTags(page.body);
  const verdict = verdictFromText(text);
  const timeM = text.match(/(\d+)\s*ms\b/);
  const memM = text.match(/(\d+)\s*(KB|MB)\b/);
  const finished = !!verdict && !/^(Waiting|Compiling|Running|Judging)$/.test(verdict);
  return {
    id: Number(id),
    verdict: verdict || 'Unknown',
    finished,
    time: timeM ? timeM[1] + 'ms' : '',
    memory: memM ? memM[1] + memM[2] : ''
  };
}

async function qojStatus() {
  if (!qoj.loggedIn) {
    try {
      const home = await fetchPage(QOJ_ORIGIN + '/');
      const t = stripTags(home.body);
      if (/logout|退出|Sign out/i.test(t)) {
        qoj.loggedIn = true;
        const m = home.body.match(/\/user\/profile\/([^"?]+)/);
        if (m) qoj.user = decodeURIComponent(m[1]);
      }
    } catch (e) {
      qojDbg('状态检查失败: ' + e.message);
    }
  }
  return { loggedIn: qoj.loggedIn, user: qoj.user, languages: qoj.languages };
}

/* ---------------- HTTP 服务器 ---------------- */

const OPEN_HOSTS = ['qoj.ac'];

function openInBrowser(url) {
  if (process.platform === 'win32') {
    execFile('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, function () { });
  } else if (process.platform === 'darwin') {
    execFile('open', [url], function () { });
  } else {
    execFile('xdg-open', [url], function () { });
  }
}

function sendJson(res, code, obj, cache) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': cache || 'no-store'
  };
  if (cache) headers['Vary'] = 'Accept-Encoding';
  res.writeHead(code, headers);
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 8 * 1024 * 1024)) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* 静态资源：ETag + 304 + gzip（MDN HTTP caching 的常规做法：ETag 用文件 mtime+size，
   文本资源压缩后缓存，浏览器二次访问只做条件请求） */
const zlib = require('zlib');
const gzipCache = new Map();          // file -> {etag, mtime, size, body}

function compressible(ext) {
  return ['.html', '.js', '.css', '.json', '.svg', '.txt'].indexOf(ext) >= 0;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const ext = path.extname(file).toLowerCase();
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'ETag': etag,
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate'
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const acceptGzip = /gzip/i.test(req.headers['accept-encoding'] || '');
    if (compressible(ext) && acceptGzip) {
      const hit = gzipCache.get(file);
      const fresh = hit && hit.etag === etag;
      const sendBody = (buf) => {
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        headers['Content-Length'] = buf.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : buf);
      };
      if (fresh) return sendBody(hit.body);
      fs.readFile(file, (e2, raw) => {
        if (e2) { res.writeHead(500); res.end('Read error'); return; }
        const gz = zlib.gzipSync(raw, { level: 6 });
        gzipCache.set(file, { etag: etag, body: gz });
        sendBody(gz);
      });
      return;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + HOST + ':' + PORT);
  try {
    if (u.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, app: 'vp-board-better', qoj: true, port: PORT });
    }

    if (u.pathname === '/api/window') {
      const file = path.join(ROOT, '_window.json');
      if (req.method === 'POST') {
        try {
          const raw = await readBody(req, 4096);
          const o = JSON.parse(raw || '{}');
          const w = Math.round(Number(o.w) || 0);
          const h = Math.round(Number(o.h) || 0);
          const x = Math.round(Number(o.x));
          const y = Math.round(Number(o.y));
          if (w < 900 || h < 600 || w > 5000 || h > 4000) {
            return sendJson(res, 400, { ok: false, error: '窗口尺寸不合理' });
          }
          const rec = { w: w, h: h, ts: Date.now() };
          if (isFinite(x) && isFinite(y) && Math.abs(x) < 20000 && Math.abs(y) < 20000) {
            rec.x = x;
            rec.y = y;
          }
          fs.writeFileSync(file, JSON.stringify(rec), 'utf8');
          return sendJson(res, 200, { ok: true, w: w, h: h, x: rec.x, y: rec.y });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: '保存窗口尺寸失败：' + e.message });
        }
      }
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { }
      const w = saved && saved.w ? saved.w : 1440;
      const h = saved && saved.h ? saved.h : 900;
      return sendJson(res, 200, { ok: true, w: w, h: h });
    }

    if (u.pathname === '/api/open') {
      const target = (u.searchParams.get('url') || '').trim();
      let t = null;
      try { t = new URL(target); } catch (e) { }
      if (!t || (t.protocol !== 'http:' && t.protocol !== 'https:')) {
        return sendJson(res, 400, { ok: false, error: '链接不合法' });
      }
      const host = t.hostname.toLowerCase();
      const allowed = OPEN_HOSTS.some(function (h) { return host === h || host.slice(-h.length - 1) === '.' + h; });
      if (!allowed) return sendJson(res, 403, { ok: false, error: '只允许打开 QOJ 的链接' });
      openInBrowser(t.href);
      return sendJson(res, 200, { ok: true, url: t.href });
    }

    if (u.pathname === '/api/boards') {
      try {
        const idx = await boardIndex(u.searchParams.get('refresh') === '1');
        const q = String(u.searchParams.get('q') || '').trim().toLowerCase();
        const limit = Math.min(300, Math.max(1, Number(u.searchParams.get('limit') || 40) || 40));
        const hit = q
          ? idx.list.filter((x) => ((x.n || '') + ' ' + x.p).toLowerCase().indexOf(q) >= 0)
          : idx.list;
        return sendJson(res, 200, { ok: true, total: idx.list.length, matched: hit.length, ts: idx.ts, items: hit.slice(0, limit) }, 'public, max-age=300');
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: '读取榜单列表失败：' + e.message });
      }
    }

    if (u.pathname === '/api/proxy') {
      const target = u.searchParams.get('url');
      if (!target) return sendJson(res, 400, { ok: false, error: '缺少 url' });
      let tu;
      try { tu = new URL(target); } catch (e) { return sendJson(res, 400, { ok: false, error: '非法 url' }); }
      if (!PROXY_HOSTS.has(tu.hostname)) return sendJson(res, 403, { ok: false, error: '不在白名单: ' + tu.hostname });
      const r = await rawRequest('GET', tu.toString(), { timeout: 25000 });
      res.writeHead(r.status, {
        'Content-Type': r.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(r.body);
    }

    if (u.pathname.startsWith('/api/qoj/')) {
      const action = u.pathname.slice('/api/qoj/'.length);
      if (req.method === 'POST') {
        const raw = await readBody(req);
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch (e) { payload = {}; }
        if (action === 'login') {
          try {
            const r = await cdp.login(String(payload.username || '').trim(), String(payload.password || ''));
            return sendJson(res, 200, { ok: true, user: r.user, log: cdp.log() });
          } catch (e) {
            return sendJson(res, 502, { ok: false, error: e.message, log: cdp.log() });
          }
        }
        if (action === 'logout') {
          try { await cdp.logout(); } catch (e) { /* ignore */ }
          cdp.close();
          return sendJson(res, 200, { ok: true });
        }
        if (action === 'problems') {
          try {
            const list = await cdp.problems(String(payload.contest || ''));
            return sendJson(res, 200, { ok: true, problems: list, log: cdp.log() });
          } catch (e) {
            return sendJson(res, 502, { ok: false, error: e.message, log: cdp.log() });
          }
        }
        if (action === 'submit') {
          try {
            const r = await cdp.submit(payload);
            return sendJson(res, 200, { ok: true, submissionId: r.submissionId, log: cdp.log() });
          } catch (e) {
            return sendJson(res, 502, { ok: false, error: e.message, log: cdp.log() });
          }
        }
        return sendJson(res, 404, { ok: false, error: 'unknown action' });
      }
      if (action === 'contests') {
        try {
          const all = await cdp.contests();
          const q = String(u.searchParams.get('q') || '').trim().toLowerCase();
          const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit') || 40) || 40));
          const date = String(u.searchParams.get('date') || '').trim().slice(0, 10);
          const days = Math.min(14, Math.max(0, Number(u.searchParams.get('days') || 2) || 2));
          let hit = q
            ? all.filter((c) => (c.title + ' ' + c.id).toLowerCase().indexOf(q) >= 0)
            : all;
          // 按比赛日期找：榜单和 QOJ 的标题语言经常对不上（中文站名 vs 英文题名），
          // 但开赛日期是一致的，用日期圈定候选再由人挑最稳。
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            const base = new Date(date + 'T00:00:00').getTime();
            if (!isNaN(base)) {
              hit = hit.filter((c) => {
                const s = String(c.start || '').slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
                const t = new Date(s + 'T00:00:00').getTime();
                return !isNaN(t) && Math.abs(t - base) <= days * 86400000;
              });
            }
          }
          return sendJson(res, 200, { ok: true, total: all.length, matched: hit.length, date: date, days: days, items: hit.slice(0, limit), log: cdp.log() }, 'public, max-age=600');
        } catch (e) {
          return sendJson(res, 502, { ok: false, error: e.message, log: cdp.log() });
        }
      }
      if (action === 'editorial') {
        try {
          const r = await cdp.editorials(String(u.searchParams.get('contest') || ''));
          return sendJson(res, 200, { ok: true, contest: r.contest, items: r.items, pick: r.pick, log: cdp.log() });
        } catch (e) {
          return sendJson(res, 502, { ok: false, error: e.message, log: cdp.log() });
        }
      }
      if (action === 'status') {
        const s = await cdp.status();
        return sendJson(res, 200, Object.assign({ ok: true }, s));
      }
      if (action === 'submission') {
        const id = u.searchParams.get('id');
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' });
        try {
          const s = await cdp.submission(id);
          return sendJson(res, 200, Object.assign({ ok: true }, s));
        } catch (e) {
          return sendJson(res, 502, { ok: false, error: e.message });
        }
      }
      return sendJson(res, 404, { ok: false, error: 'unknown action' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); return res.end('Method Not Allowed');
    }
    serveStatic(req, res, u.pathname);
  } catch (e) {
    log('请求出错', e.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log('端口 ' + PORT + ' 已被占用（启动器可能已在运行）：http://' + HOST + ':' + PORT + '/');
    process.exit(0);
  }
  log('服务器错误', e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log('启动器已就绪: http://' + HOST + ':' + PORT + '/');
  log('静态目录: ' + ROOT);
});

// 退出时关掉 QOJ 用的独立浏览器
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    try { cdp.close(); } catch (e) { }
    process.exit(0);
  });
});
process.on('exit', () => { try { cdp.close(); } catch (e) { } });
