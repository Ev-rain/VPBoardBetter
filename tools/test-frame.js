/* 自绘标题栏测试：/api/frame 代理（Task 1）、标题条结构（Task 2）、页面交互（Task 3） */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FRAME_PORT = 8790;
const APP_PORT = 8793;
const VOID_TAGS = { img: 1, input: 1, br: 1, meta: 1, link: 1, hr: 1, source: 1, area: 1, base: 1, col: 1, embed: 1, param: 1, track: 1, wbr: 1 };

let failures = 0;
function ok(cond, msg, extra) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ---------- 最小 DOM：从真实 index.html 解析出可查询/可派发事件的节点树 ---------- */
function createNode(tag, attrs, doc) {
  const node = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    attrs: attrs || {},
    children: [],
    parentNode: null,
    _text: '',
    _listeners: {},
    style: {},
    dataset: {}
  };
  Object.defineProperty(node, 'id', { get: function () { return this.attrs.id || ''; } });
  Object.defineProperty(node, 'className', { get: function () { return this.attrs.class || ''; } });
  Object.defineProperty(node, 'hidden', {
    get: function () { return Object.prototype.hasOwnProperty.call(this.attrs, 'hidden'); },
    set: function (v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; }
  });
  Object.defineProperty(node, 'textContent', {
    get: function () {
      let s = this._text || '';
      this.children.forEach(function (c) { s += c.textContent || ''; });
      return s;
    },
    set: function (v) { this._text = String(v); }
  });
  node.classList = {
    add: function (c) { const l = node.className.split(/\s+/).filter(Boolean); if (l.indexOf(c) < 0) l.push(c); node.attrs.class = l.join(' '); },
    remove: function (c) { node.attrs.class = node.className.split(/\s+/).filter(function (x) { return x && x !== c; }).join(' '); },
    contains: function (c) { return node.className.split(/\s+/).indexOf(c) >= 0; },
    toggle: function (c) { this.contains(c) ? this.remove(c) : this.add(c); }
  };
  node.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
  node.setAttribute = function (k, v) { this.attrs[k] = String(v); };
  node.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; };
  node.removeAttribute = function (k) { delete this.attrs[k]; };
  node.addEventListener = function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); };
  node.removeEventListener = function (type, fn) {
    const l = this._listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  };
  node.dispatchEvent = function (evt) {
    evt = evt || { type: 'click' };
    if (!evt.target) evt.target = this;
    if (!evt.preventDefault) evt.preventDefault = function () { evt.defaultPrevented = true; };
    if (!evt.stopPropagation) evt.stopPropagation = function () { };
    let cur = this;
    while (cur) {
      (cur._listeners[evt.type] || []).slice().forEach(function (fn) { fn.call(cur, evt); });
      cur = cur.parentNode;
    }
    return !evt.defaultPrevented;
  };
  node.matches = function (sel) { return matchesSel(node, sel); };
  node.closest = function (sel) {
    let cur = this;
    while (cur) { if (cur.nodeType === 1 && matchesSel(cur, sel)) return cur; cur = cur.parentNode; }
    return null;
  };
  node.querySelectorAll = function (sel) { const out = []; walk(node, function (n) { if (n.nodeType === 1 && n !== node && matchesSel(n, sel)) out.push(n); }); return out; };
  node.querySelector = function (sel) { return node.querySelectorAll(sel)[0] || null; };
  node.focus = function () { };
  node.blur = function () { };
  node.click = function () { this.dispatchEvent({ type: 'click' }); };
  if (doc) node.ownerDocument = doc;
  return node;
}

function walk(n, fn) { n.children.forEach(function (c) { fn(c); walk(c, fn); }); }

function matchesSel(node, sel) {
  sel = String(sel).trim();
  if (!sel) return false;
  if (sel.charAt(0) === '#') return node.id === sel.slice(1);
  if (sel.charAt(0) === '.') return node.classList.contains(sel.slice(1));
  if (sel.indexOf('[') === 0) {
    const m = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(sel);
    if (!m) return false;
    return m[2] === undefined ? Object.prototype.hasOwnProperty.call(node.attrs, m[1]) : node.attrs[m[1]] === m[2];
  }
  if (/^[a-zA-Z]/.test(sel)) return node.tagName === sel.toUpperCase();
  return false;
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
  }
  return attrs;
}

function loadDom(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const doc = createNode('document', {}, null);
  doc.nodeType = 9;
  const ids = {};
  const stack = [doc];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].indexOf('<!--') === 0) continue;
    if (m[1]) {
      const tag = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    if (m[2]) {
      const node = createNode(m[2], parseAttrs(m[3] || ''), doc);
      node.parentNode = stack[stack.length - 1];
      node.parentNode.children.push(node);
      if (node.id) ids[node.id] = node;
      if (!VOID_TAGS[m[2].toLowerCase()] && m[4] !== '/') stack.push(node);
      continue;
    }
    if (m[5] !== undefined) {
      const parent = stack[stack.length - 1];
      if (parent && parent.nodeType === 1) parent._text += m[5];
    }
  }
  doc.getElementById = function (id) { return ids[id] || null; };
  doc.documentElement = doc.children[0] || doc;
  doc.head = doc.querySelector('head');
  doc.body = doc.querySelector('body') || createNode('body', {}, doc);
  if (!doc.body.parentNode) doc.documentElement.appendChild(doc.body);
  doc.createElement = function (tag) { return createNode(tag, {}, doc); };
  doc.createTextNode = function (t) { const n = createNode('#text', {}, doc); n.nodeType = 3; n._text = t; return n; };
  doc.querySelector = function (sel) { return doc.querySelectorAll(sel)[0] || null; };
  doc.querySelectorAll = function (sel) { const out = []; walk(doc, function (n) { if (n.nodeType === 1 && matchesSel(n, sel)) out.push(n); }); return out; };
  doc.addEventListener = function () { };
  doc.removeEventListener = function () { };
  doc._ids = ids;
  return doc;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function get(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function post(url) {
  const r = await fetch(url, { method: 'POST' });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function startFakeHelper() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, hwnd: '1', maximized: false }));
    }
    res.writeHead(204);
    res.end();
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(FRAME_PORT, '127.0.0.1', () => resolve(srv));
  });
}

function stopServer(srv) {
  return new Promise(r => srv.close(() => r()));
}

async function waitFor(url, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch (e) { }
    await sleep(150);
  }
  return false;
}

async function testProxy() {
  let helper = await startFakeHelper();
  const app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(APP_PORT), FRAME_PORT: String(FRAME_PORT) }),
    stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + APP_PORT;

  try {
    const up = await waitFor(base + '/api/health', 60);
    ok(up, '本地服务已启动');
    if (!up) throw new Error('service did not start');

    console.log('— /api/frame 代理 —');
    const st = await get(base + '/api/frame/state');
    ok(st.status === 200, 'GET /api/frame/state 200', st);
    ok(st.body && st.body.ok === true && st.body.active === true && st.body.maximized === false,
      'state 透传 active/maximized', st.body);

    const mn = await post(base + '/api/frame/min');
    ok(mn.status === 200 && mn.body && mn.body.ok === true, 'POST /api/frame/min → {ok:true}', mn.body);

    const bogus = await post(base + '/api/frame/bogus');
    ok(bogus.status === 400 && bogus.body && bogus.body.ok === false &&
      bogus.body.error === 'unknown frame command', '未知命令 400', bogus.body);

    await stopServer(helper);
    helper = null;
    await sleep(120);

    const off = await get(base + '/api/frame/state');
    ok(off.status === 200 && off.body && off.body.ok === true && off.body.active === false,
      'helper 不在时 state 返回 active:false', off.body);

    const close = await post(base + '/api/frame/close');
    ok(close.status === 502 && close.body && close.body.ok === false &&
      close.body.error === '没有自绘窗口', 'helper 不在时 close 返回 502', close.body);
  } finally {
    if (helper && helper.listening) await stopServer(helper);
    app.kill();
  }
}

function testTitlebar() {
  console.log('— 标题条结构 —');
  const doc = loadDom(path.join(ROOT, 'index.html'));
  const bar = doc.getElementById('titlebar');
  ok(bar, '有 #titlebar');
  if (!bar) return;
  ok(bar.hidden === true, '默认隐藏（hidden）');
  ok(doc.getElementById('tbTitle'), '有 #tbTitle');
  ['tbMin', 'tbMax', 'tbClose'].forEach(function (id) {
    const b = doc.getElementById(id);
    ok(b && b.tagName === 'BUTTON' && b.classList.contains('tb-btn'), '有按钮 #' + id);
  });
  const close = doc.getElementById('tbClose');
  ok(close && close.classList.contains('tb-close'), '关闭按钮带 tb-close');

  const css = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8').replace(/\s+/g, ' ');
  ok(/\.titlebar\s*\{[^}]*height:\s*34px/.test(css), '.titlebar 高 34px');
  ok(/body\.framed\s+\.titlebar\s*\{[^}]*display:\s*flex/.test(css), 'body.framed 时显示标题条');
  ok(/\.tb-btn\s*\{[^}]*width:\s*46px[^}]*height:\s*34px/.test(css), '按钮 46×34');
  ok(/\.tb-close:hover\s*\{[^}]*#e81123/.test(css), '关闭 hover #e81123');
}

/* ---------- 在最小 DOM 里加载 core.js + app.js ---------- */
function loadApp(doc) {
  const vm = require('vm');
  const storage = {
    _m: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
    setItem: function (k, v) { this._m[k] = String(v); },
    removeItem: function (k) { delete this._m[k]; }
  };
  const ctx = {
    console: console, Math: Math, Date: Date, JSON: JSON, Promise: Promise,
    setTimeout: function () { return 0; }, clearTimeout: function () { },
    setInterval: function () { return 0; }, clearInterval: function () { },
    requestAnimationFrame: function () { return 0; }, cancelAnimationFrame: function () { },
    document: doc, localStorage: storage,
    location: { search: '', href: 'http://127.0.0.1:8787/', hash: '' },
    navigator: { language: 'zh-CN' },
    screen: { availWidth: 1920, availHeight: 1080 },
    URLSearchParams: URLSearchParams,
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ active: false }); } }); }
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.addEventListener = function () { };
  ctx.removeEventListener = function () { };
  vm.createContext(ctx);
  ['assets/core.js', 'assets/app.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  });
  return ctx;
}

async function testInteraction() {
  console.log('— 页面交互 —');
  const doc = loadDom(path.join(ROOT, 'index.html'));
  const ctx = loadApp(doc);
  const vpApp = ctx.VPApp;
  ok(vpApp && typeof vpApp.initFrame === 'function', 'VPApp.initFrame 存在');
  if (!vpApp || typeof vpApp.initFrame !== 'function') return;

  const calls = [];
  const send = function (cmd) { calls.push('/api/frame/' + cmd); return Promise.resolve(true); };

  await vpApp.initFrame({ state: { active: true, maximized: false }, cmd: send });
  ok(doc.getElementById('titlebar').hidden === false, 'helper 在线时显示标题条');
  ok(doc.body.classList.contains('framed'), 'body 加 framed');
  ok(doc.getElementById('tbMax').textContent === '□', '最大化按钮显示 □');

  doc.getElementById('tbMin').dispatchEvent({ type: 'mousedown', button: 0 });
  ok(JSON.stringify(calls) === JSON.stringify(['/api/frame/min']), '点最小化只发 min，不触发拖动', calls);

  doc.getElementById('tbTitle').dispatchEvent({ type: 'mousedown', button: 0 });
  ok(JSON.stringify(calls) === JSON.stringify(['/api/frame/min', '/api/frame/drag']), '标题区按下发 drag', calls);

  doc.getElementById('tbMax').dispatchEvent({ type: 'mousedown', button: 0 });
  doc.getElementById('tbClose').dispatchEvent({ type: 'mousedown', button: 0 });
  ok(JSON.stringify(calls.slice(-2)) === JSON.stringify(['/api/frame/max', '/api/frame/close']), '最大化/关闭按钮', calls);

  await vpApp.initFrame({ state: { active: false }, cmd: send });
  ok(doc.getElementById('titlebar').hidden === true, '没有 helper 时隐藏标题条');
  ok(!doc.body.classList.contains('framed'), '没有 helper 时不加 framed');
}

async function main() {
  await testProxy();
  testTitlebar();
  await testInteraction();
  console.log(failures === 0 ? '\n全部通过 ✓' : '\n失败 ' + failures + ' 项 ✗');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
