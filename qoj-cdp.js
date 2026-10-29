/* ============================================================
   qoj-cdp.js — 用本机 Edge + DevTools 协议驱动 QOJ
   ------------------------------------------------------------
   为什么不用纯 HTTP：qoj.ac 前面有 Cloudflare 人机验证，
   非浏览器请求只会拿到 “Just a moment…” 403。
   这里直接开一个真实的 Edge 窗口（--app 模式），由它在页面里
   执行 fetch / 提交表单，天然带着验证过的 cookie。

   账号密码只经过本进程内存，不落盘；登录状态保存在
   .qoj-profile 浏览器配置目录里（下次免登录）。
   ============================================================ */
'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const ORIGIN = 'https://qoj.ac';
const PORT = Number(process.env.QOJ_CDP_PORT || 9333);
const LEGACY_PROFILE = path.join(__dirname, '.qoj-profile');
/* 参照 Playwright 的 storageState 思路：不再长期保留浏览器配置目录，
   每次用系统临时目录里的全新 profile 启动，登录态只导出成一个几 KB 的
   cookie JSON（qoj-session.json），下次启动前用 CDP Storage.setCookies 注入。
   这样既不会产生几百 MB 的组件缓存，也不用每次输密码。*/
const PROFILE = path.join(os.tmpdir(), 'vpb-qoj-' + process.pid);
const PROFILE_MARKER = 'vpb-qoj-'; // 只要命令行里带这个前缀，就是我们自己的 QOJ 浏览器
const SESSION_FILE = process.env.QOJ_SESSION
  ? path.resolve(process.env.QOJ_SESSION)
  : path.join(__dirname, 'qoj-session.json');
const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch (err) { } }
    }
  };
  walk(p);
  return total;
}

function removeDir(p) {
  if (!p) return;
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); }
  catch (e) { dbg('删除目录失败: ' + p + '（' + e.message + '）'); }
}

function dropLegacyProfile() {
  try {
    if (!fs.existsSync(LEGACY_PROFILE)) return;
    const size = dirSize(LEGACY_PROFILE);
    removeDir(LEGACY_PROFILE);
    if (!fs.existsSync(LEGACY_PROFILE)) dbg('删除旧配置目录: ' + (size / 1048576).toFixed(1) + ' MB');
  } catch (e) { }
}let browser = null;          // { ws, send }
let edgeProc = null;
let state = { loggedIn: false, user: '' };
let restored = false;
let debugLog = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dbg(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  debugLog.push(stamp + ' ' + line);
  if (debugLog.length > 160) debugLog.shift();
}

function log() { return debugLog.slice(); }

function findEdge() {
  for (const p of EDGE_PATHS) { try { if (fs.existsSync(p)) return p; } catch (e) { } }
  return null;
}

function getJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeout || 3000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('devtools timeout')));
  });
}

async function waitDevtools(ms) {
  const until = Date.now() + (ms || 20000);
  while (Date.now() < until) {
    try {
      const list = await getJson('http://127.0.0.1:' + PORT + '/json/list', 1200);
      if (Array.isArray(list) && list.length) return list;
    } catch (e) { /* not up yet */ }
    await sleep(300);
  }
  return null;
}

async function launch() {
  const exe = findEdge();
  if (!exe) throw new Error('找不到 Edge / Chrome，无法驱动 QOJ');
  try { if (fs.existsSync(PROFILE)) removeDir(PROFILE); } catch (e) { }
  fs.mkdirSync(PROFILE, { recursive: true });
  dropLegacyProfile();
  cleanupStaleProfiles();
  const visible = process.env.QOJ_VISIBLE === '1';
  const args = [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check',
    '--app=' + ORIGIN + '/login',
    '--window-size=1080,820',
    /* 默认把窗口放到屏幕外：进程照常渲染（Cloudflare 才会放行），但看不到弹出的窗口；
       QOJ_VISIBLE=1 时才放在屏幕里，方便排查问题 */
    visible ? '--window-position=120,90' : '--window-position=-32000,-32000',
    '--disable-features=Translate,MediaRouter,msEdgeIdentityAvatar,CalculateNativeWinOcclusion',
    '--disable-component-update', '--disable-background-networking',
    '--disable-sync', '--disable-default-apps', '--disable-extensions',
    '--disable-breakpad', '--disable-client-side-phishing-detection',
    '--noerrdialogs', '--disable-session-crashed-bubble',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
  ];
  dbg('启动浏览器: ' + path.basename(exe));
  const proc = spawn(exe, args, { detached: false, stdio: 'ignore' });
  edgeProc = proc;
  proc.on('exit', (code) => {
    dbg('浏览器退出 code=' + code);
    if (edgeProc === proc) edgeProc = null;
    if (browser && browser.owned) browser = null;
  });
  const list = await waitDevtools(25000);
  if (!list) throw new Error('浏览器启动超时（DevTools 端口未就绪）');
  hideWindow();
  return list;
}

/* 把浏览器主窗口 SW_HIDE 掉：屏幕上不显示、任务栏也不留按钮，
   页面仍在后台正常渲染（Cloudflare 需要真实渲染环境）。*/
let windowHidden = false;

function hideWindow(force) {
  if (process.env.QOJ_VISIBLE === '1') return;
  if (windowHidden && !force) return;
  try {
    const script = path.join(__dirname, 'tools', 'hide-edge-window.ps1');
    if (!fs.existsSync(script)) { dbg('隐藏窗口: 找不到 ' + script); return; }
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Profile', PROFILE_MARKER, '-Action', 'hide'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const out = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/).pop();
    windowHidden = true;
    dbg('隐藏窗口: ' + (out || 'no-output'));
  } catch (e) { dbg('隐藏窗口失败: ' + e.message); }
}

async function connect(depth) {
  const level = depth || 0;
  if (browser && browser.ws && browser.ws.readyState === 1) return;
  let list = null;
  try { list = await getJson('http://127.0.0.1:' + PORT + '/json/list', 1200); } catch (e) { }
  if (!Array.isArray(list) || !list.length) list = await launch();
  else hideWindow();
  const page = list.find((t) => t.type === 'page') || list[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error('没有可用的浏览器页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools WebSocket 连接失败')); });
  const send = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  browser = { ws, send, owned: !!edgeProc };
  await send('Page.enable');
  await send('Runtime.enable');
  dbg('已连接页面: ' + (page.url || ''));

  const alive = await Promise.race([
    send('Runtime.evaluate', { expression: '1', returnByValue: true }),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000))
  ]);
  if (!alive) {
    dbg('页面无响应，重置浏览器（第 ' + level + ' 次）');
    killBrowser();
    killBrowserProcesses();
    killPortListener();
    if (level >= 2) throw new Error('QOJ 浏览器连续无响应，已重置端口仍失败');
    return connect(level + 1);
  }
  if (!restored) {
    restored = true;
    const injected = await restoreSession();
    if (injected) {
      await send('Page.navigate', { url: ORIGIN + '/login' });
      await ready();
    }
  }
}

/* ---- 登录态：导出成 cookie JSON（Playwright storageState 的做法） ---- */

const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'priority'];

function isQojCookie(c) {
  return String((c && c.domain) || '').replace(/^\./, '').endsWith('qoj.ac');
}

async function restoreSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return false;
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const cookies = (saved.cookies || []).filter(isQojCookie).map((c) => {
      const o = {};
      for (const k of COOKIE_FIELDS) if (c[k] !== undefined) o[k] = c[k];
      if (!o.path) o.path = '/';
      if (o.expires === null || o.expires === undefined) o.expires = -1;
      return o;
    });
    if (!cookies.length) return false;
    const r = await browser.send('Storage.setCookies', { cookies });
    if (r && r.error) { dbg('恢复登录态失败: ' + (r.error.message || '')); return false; }
    dbg('恢复登录态: ' + cookies.length + ' 个 cookie');
    return true;
  } catch (e) {
    dbg('恢复登录态失败: ' + e.message);
    return false;
  }
}

async function saveSession() {
  try {
    const r = await browser.send('Storage.getCookies', {});
    const cookies = ((r && r.result && r.result.cookies) || []).filter(isQojCookie);
    if (!cookies.length) return false;
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: Date.now(), cookies }), 'utf8');
    dbg('已保存登录态: ' + cookies.length + ' 个 cookie');
    return true;
  } catch (e) {
    dbg('保存登录态失败: ' + e.message);
    return false;
  }
}

function clearSession() {
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch (e) { }
}

function killBrowser() {
  try { if (browser && browser.ws) browser.ws.close(); } catch (e) { }
  browser = null;
  edgeProc = null;
}

function killPortListener() {
  try {
    const out = require('child_process').execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const pids = new Set();
    out.split(/\r?\n/).forEach((line) => {
      if (!/LISTENING/i.test(line)) return;
      if (line.indexOf(':' + PORT + ' ') < 0 && !line.includes(':' + PORT + '\t')) return;
      const m = /\s(\d+)\s*$/.exec(line.trim());
      if (m) pids.add(m[1]);
    });
    pids.forEach((pid) => {
      try { require('child_process').execSync('taskkill /F /PID ' + pid, { stdio: 'ignore', timeout: 8000, windowsHide: true }); } catch (e) { }
    });
    if (pids.size) dbg('结束占用端口 ' + PORT + ' 的进程: ' + Array.from(pids).join(','));
  } catch (e) { }
}

function killBrowserProcesses() {
  try {
    const script = path.join(__dirname, 'tools', 'kill-qoj-browser.ps1');
    if (!fs.existsSync(script)) return;
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Profile', PROFILE_MARKER], { windowsHide: true, timeout: 20000 });
  } catch (e) { }
}

async function evaluate(expr, timeoutMs) {
  const limit = timeoutMs || 15000;
  const r = await Promise.race([
    browser.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('页面无响应（' + limit + 'ms），浏览器可能被后台冻结')), limit))
  ]).catch((e) => { killBrowser(); killBrowserProcesses(); throw e; });
  if (!r || !r.result) return null;
  if (r.result.exceptionDetails) {
    const ex = r.result.exceptionDetails;
    const desc = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || '未知错误';
    throw new Error('页面脚本出错: ' + String(desc).split('\n')[0]);
  }
  return r.result.result ? r.result.result.value : null;
}

async function ready() {
  for (let i = 0; i < 40; i++) {
    try {
      const st = await evaluate('document.readyState');
      if (st === 'complete') return true;
    } catch (e) { }
    await sleep(200);
  }
  return false;
}

async function goto(url) {
  dbg('打开 ' + url);
  await browser.send('Page.navigate', { url });
  await sleep(250);
  await ready();
}

async function waitFor(expr, timeoutMs, label) {
  const until = Date.now() + (timeoutMs || 20000);
  while (Date.now() < until) {
    try { if (await evaluate(expr)) return true; } catch (e) { }
    await sleep(300);
  }
  throw new Error('等待超时：' + (label || expr));
}

function js(v) { return JSON.stringify(String(v == null ? '' : v)); }

async function text() {
  try { return await evaluate('document.body ? document.body.innerText : ""'); } catch (e) { return ''; }
}

/* ---------------- 登录 ---------------- */

async function bringToFront() {
  /* 默认窗口在屏幕外，不需要（也不该）抢焦点；设 QOJ_VISIBLE=1 才把窗口提到前面来 */
  if (process.env.QOJ_VISIBLE !== '1') return;
  try { await browser.send('Page.bringToFront'); } catch (e) { }
}

async function banner(msg) {
  try {
    await evaluate(`(() => {
      let d = document.getElementById('__vp_banner');
      if (!d) {
        d = document.createElement('div');
        d.id = '__vp_banner';
        d.style.cssText = 'position:fixed;z-index:2147483647;left:0;right:0;top:0;background:#7f1d1d;color:#fff;' +
          'font:13px/1.7 system-ui,"Segoe UI",sans-serif;padding:8px 14px;box-shadow:0 2px 12px rgba(0,0,0,.35)';
        (document.body || document.documentElement).appendChild(d);
      }
      d.textContent = ${js(msg)};
    })()`);
  } catch (e) { }
}

/* 已登录的可靠标志：导航栏里有 Logout 链接。
   注意不能拿 a[href^="/user/profile/"] 判断——页脚 “Made with ❤️ by Qingyu” 也是这种链接。 */
async function isLoggedIn() {
  try {
    return !!(await evaluate('!!document.querySelector(\'a[href*="/logout"]\')'));
  } catch (e) { return false; }
}

async function profileHref() {
  try {
    return await evaluate(`(() => {
      const a = document.querySelector('a.uoj-username[href*="/user/profile/"]');
      return a ? a.getAttribute('href') : '';
    })()`) || '';
  } catch (e) { return ''; }
}

async function login(username, password) {
  debugLog = [];
  if (!username || !password) throw new Error('请填写 QOJ 用户名和密码');
  await connect();
  await bringToFront();
  await goto(ORIGIN + '/login');

  // 浏览器里已经登录过（profile 里有 cookie）就直接返回
  if (await isLoggedIn()) {
    const href = await profileHref();
    const who = href ? decodeURIComponent(href.split('/').pop() || '') : username;
    state = { loggedIn: true, user: who };
    dbg('已是登录状态: ' + who);
    await saveSession();
    return { user: who };
  }

  // 等登录框：Cloudflare 偶尔要人点一下，窗口在前台，用户能看到
  await waitFor('!!document.querySelector("input[type=password]")', 90000,
    'QOJ 登录框（如果弹出的窗口里显示 Cloudflare 验证，请手动点一下）');
  await sleep(250);
  dbg('登录框已出现');

  // 把用户名/密码真的填进页面（用户能看到输入过程，页面自己算 md5）
  const filled = await evaluate(`(() => {
    const u = document.querySelector('#input-username') || document.querySelector('input[name=username]');
    const p = document.querySelector('#input-password') || document.querySelector('input[type=password]');
    if (!u || !p) return 'missing';
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    u.focus(); set(u, ${js(username)});
    p.focus(); set(p, ${js(password)});
    return 'ok';
  })()`);
  if (filled !== 'ok') throw new Error('QOJ 登录页上没找到用户名/密码输入框（页面结构可能变了）');
  await sleep(200);
  const echo = await evaluate('(document.querySelector("#input-username") || {}).value || ""');
  dbg('已填入账号密码（' + username + '，页面回读 ' + echo + '）');

  // 点页面自己的登录按钮，走 QOJ 原生登录逻辑
  const clicked = await evaluate(`(() => {
    const all = Array.from(document.querySelectorAll('button, input[type=submit], a.btn'));
    const byId = document.getElementById('button-submit');
    if (byId) { byId.click(); return '#button-submit'; }
    const byText = all.find((el) => /^(登\\s*录|log\\s*in|login|submit)$/i.test(((el.innerText || el.value || '') + '').trim()));
    if (byText) { byText.click(); return 'text'; }
    if (typeof window.submitLoginPost === 'function') { window.submitLoginPost(); return 'submitLoginPost()'; }
    const form = document.querySelector('input[type=password]').closest('form');
    if (form) { HTMLFormElement.prototype.submit.call(form); return 'form.submit'; }
    return '';
  })()`);
  dbg('点击登录按钮: ' + (clicked || '未找到'));

  // 等结果
  let outcome = '', detail = '';
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (await isLoggedIn()) { outcome = 'ok'; break; }
    const info = await evaluate(`JSON.stringify({
      href: location.href,
      help: ((document.querySelector('#help-username') || {}).innerText || '').trim(),
      tip: ((document.querySelector('.alert, .alert-danger, .text-danger') || {}).innerText || '').trim().slice(0, 140)
    })`);
    let o = {};
    try { o = JSON.parse(info || '{}'); } catch (e) { }
    if (o.help || o.tip) { outcome = 'err'; detail = (o.help || o.tip); break; }
    if (o.href && o.href.indexOf('/login') < 0) { outcome = 'nav'; break; }
    await sleep(400);
  }

  if (outcome === 'ok' || outcome === 'nav') {
    await goto(ORIGIN + '/');
    const href = await profileHref();
    const user = (href ? decodeURIComponent(href.split('/').pop() || '') : '') || username;
    state = { loggedIn: true, user };
    dbg('登录成功: ' + user);
    await saveSession();
    return { user };
  }

  // 页面按钮没反应时，退回 AJAX（_token + md5 密码）
  dbg('页面按钮路径未确认成功（' + (outcome || '超时') + '），尝试 AJAX 登录');
  const token = await evaluate(`(() => {
    const m = document.documentElement.innerHTML.match(/_token\\s*:\\s*"([^"]+)"/);
    return m ? m[1] : '';
  })()`);
  if (!token) {
    await banner('VP Board Better 自动登录失败：页面上没找到 _token。你可以直接在这个窗口里手动登录。');
    throw new Error('页面里没找到 _token（QOJ 登录页结构可能变了）');
  }
  const hashed = crypto.createHash('md5').update(String(password), 'utf8').digest('hex');
  const res = await evaluate(`(async () => {
    const body = new URLSearchParams();
    body.set('_token', ${js(token)});
    body.set('login', '');
    body.set('username', ${js(username)});
    body.set('password', ${js(hashed)});
    body.set('trust', '');
    const r = await fetch('/login', { method: 'POST', body, credentials: 'include' });
    return (await r.text()).trim().slice(0, 40);
  })()`);
  const msg = String(res || '');
  dbg('AJAX 登录响应: ' + msg);

  if (msg === 'ok') {
    await goto(ORIGIN + '/');
    const href = await profileHref();
    const user = (href ? decodeURIComponent(href.split('/').pop() || '') : '') || username;
    state = { loggedIn: true, user };
    dbg('登录成功: ' + user);
    await saveSession();
    return { user };
  }

  const known = {
    failed: '用户名或密码错误',
    banned: '这个账号没有权限（可能被禁止登录）',
    expired: '页面会话已过期，请重试',
    secure: '出于安全原因，这次登录请求被拒绝',
    '2fa': '账号启用了两步验证，需要在浏览器里手动完成',
    pending_2fa: '管理员账号需要 2FA 令牌'
  };
  const why = known[msg] || (detail || ('QOJ 返回「' + (msg || '空响应') + '」'));
  await banner('VP Board Better 自动登录失败：' + why + '。你可以直接在这个窗口里手动登录，登录后回到榜单页面刷新即可。');
  throw new Error('登录失败：' + why);
}

async function logout() {
  try { if (browser && browser.ws) await browser.send('Page.navigate', { url: ORIGIN + '/logout' }); } catch (e) { }
  state = { loggedIn: false, user: '' };
  clearSession();
  return { ok: true };
}

/* ---------------- 题目列表 ---------------- */

async function problems(contestUrl) {
  if (!browser) await connect();
  const url = contestUrl ? new URL(contestUrl, ORIGIN + '/').toString() : ORIGIN + '/problems';
  await goto(url);
  const t = await text();
  if (/Please login|请先登录/i.test(t)) throw new Error('还没有登录 QOJ');
  await sleep(300);
  const raw = await evaluate(`(() => {
    const out = [], seen = new Set();
    document.querySelectorAll('a[href*="/problem/"]').forEach(a => {
      const m = /\\/problem\\/(\\d+)/.exec(a.getAttribute('href') || '');
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      out.push({ id: m[1], href: a.getAttribute('href'), label: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) });
    });
    return JSON.stringify(out);
  })()`);
  let list = [];
  try { list = JSON.parse(raw || '[]'); } catch (e) { list = []; }
  dbg('题目页 ' + url + ' → ' + list.length + ' 题');
  if (!list.length) throw new Error('没有在页面里找到题目链接，确认这个比赛链接是否正确');
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return list.map((x, i) => ({ id: x.id, href: x.href, label: x.label, letter: letters[i] || String(i + 1) }));
}

/* ---------------- 题解附件 ---------------- */

async function editorials(contestUrl) {
  const raw = String(contestUrl || '').trim();
  if (!raw) throw new Error('还没有关联 QOJ 比赛');
  const url = /^\d+$/.test(raw) ? ORIGIN + '/contest/' + raw : new URL(raw, ORIGIN + '/').toString();
  if (!browser) await connect();
  await goto(url);
  await sleep(500);
  const t = await text();
  if (/Please login|请先登录/i.test(t)) throw new Error('还没有登录 QOJ');
  const out = await evaluate(`(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const items = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const t = norm(a.textContent);
      const h = a.getAttribute('href') || '';
      if (!t || t.length > 80) return;
      if (!/tutorial|题解|editorial|solution/i.test(t + ' ' + h)) return;
      items.push({ text: t, href: a.href });
    });
    return JSON.stringify(items);
  })()`);
  let items = [];
  try { items = JSON.parse(out || '[]'); } catch (e) { items = []; }
  const seen = new Set();
  items = items.filter(function (x) {
    if (!x.href || seen.has(x.href)) return false;
    seen.add(x.href);
    return true;
  });
  items = items.map(function (x) {
    const m = /\(([a-zA-Z-]{2,10})\)\s*$/.exec(x.text);
    return { text: x.text, href: x.href, lang: m ? m[1].toLowerCase() : '' };
  });
  const pick = items.find(function (x) { return x.lang === 'zh-cn'; })
    || items.find(function (x) { return /^zh/i.test(x.lang); })
    || items.find(function (x) { return x.lang === 'en'; })
    || items.find(function (x) { return /tutorial/i.test(x.text); })
    || items[0] || null;
  dbg('题解页 ' + url + ' → ' + items.length + ' 个候选，选中: ' + (pick ? pick.text : '无'));
  return { contest: url, items: items, pick: pick };
}

/* ---------------- 比赛列表 ---------------- */

let contestsCache = { ts: 0, list: [] };
const CONTESTS_CACHE_FILE = path.join(__dirname, '_qoj-contests.cache.json');

function readContestsDisk() {
  try {
    if (!fs.existsSync(CONTESTS_CACHE_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(CONTESTS_CACHE_FILE, 'utf8'));
    if (!j || !Array.isArray(j.list) || !j.list.length) return null;
    return j;
  } catch (e) { return null; }
}

function writeContestsDisk(list) {
  try { fs.writeFileSync(CONTESTS_CACHE_FILE, JSON.stringify({ ts: Date.now(), list: list }), 'utf8'); } catch (e) { }
}

async function fetchContestsOnce() {
  const now = Date.now();
  if (!browser) await connect();
  let here = '';
  try { here = String(await evaluate('location.href')); } catch (e) { here = ''; }
  if (!/^https?:\/\/qoj\.ac\//.test(here)) await goto(ORIGIN + '/contests');
  const raw = await evaluate(`(async () => {
    const html = await (await fetch('/contests', { credentials: 'include' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const byId = new Map();
    doc.querySelectorAll('a[href*="/contest/"]').forEach(a => {
      const m = /\\/contest\\/(\\d+)/.exec(a.getAttribute('href') || '');
      if (!m) return;
      const id = m[1];
      const title = (a.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!title) return;
      const row = a.closest('tr') || a.closest('li') || a.parentElement;
      const rowText = row ? (row.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      const dm = /(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})/.exec(rowText);
      const start = dm ? dm[1] + '-' + dm[2] + '-' + dm[3] + ' ' + dm[4] + ':' + dm[5] : '';
      const cur = byId.get(id);
      if (!cur) byId.set(id, { id, title, start });
      else if (title.length > cur.title.length) { cur.title = title; if (start) cur.start = start; }
    });
    return JSON.stringify(Array.from(byId.values()));
  })()`);
  let list = [];
  try { list = JSON.parse(raw || '[]'); } catch (e) { list = []; }
  list.sort((a, b) => Number(b.id) - Number(a.id));
  contestsCache = { ts: now, list };
  writeContestsDisk(list);
  dbg('比赛列表 ' + list.length + ' 场');
  return list;
}

async function contests() {
  const now = Date.now();
  if (contestsCache.list.length && now - contestsCache.ts < 10 * 60 * 1000) return contestsCache.list;
  try {
    return await fetchContestsOnce();
  } catch (e) {
    dbg('取比赛列表失败: ' + e.message);
    killBrowser();
    try {
      const list = await fetchContestsOnce();
      return list;
    } catch (e2) {
      dbg('重试仍失败: ' + e2.message);
      const disk = readContestsDisk();
      if (disk) {
        dbg('使用本地缓存的比赛列表（' + disk.list.length + ' 场）');
        contestsCache = { ts: disk.ts, list: disk.list };
        return disk.list;
      }
      throw e2;
    }
  }
}

/* ---------------- 提交 ---------------- */

function normalizeLang(lang) {
  const map = {
    'cpp17': 'C++17', 'cpp14': 'C++14', 'cpp11': 'C++11', 'cpp': 'C++',
    'c': 'C', 'python3': 'Python3', 'py3': 'Python3', 'python': 'Python3',
    'java': 'Java', 'pascal': 'Pascal', 'rust': 'Rust', 'go': 'Go'
  };
  const key = String(lang || 'cpp17').toLowerCase().replace(/[^a-z0-9]/g, '');
  return map[key] || String(lang || 'C++17');
}

async function submit(opts) {
  if (!browser) await connect();
  const problemId = String(opts.problemId || '').replace(/[^\d]/g, '');
  if (!problemId) throw new Error('缺少 problem id');
  const code = String(opts.code || '');
  if (!code.trim()) throw new Error('代码是空的');
  const lang = normalizeLang(opts.language);

  const url = opts.problemUrl ? new URL(opts.problemUrl, ORIGIN).toString() : ORIGIN + '/problem/' + problemId;
  await goto(url);
  await waitFor('!!document.querySelector("#form-answer textarea, form.form-horizontal textarea")', 25000, '提交框');

  const res = await evaluate(`(() => {
    const form = document.querySelector('#form-answer') || document.querySelector('form.form-horizontal');
    if (!form) return 'no-form';
    const ta = form.querySelector('textarea[name="answer_config_editor"]') || form.querySelector('textarea');
    if (!ta) return 'no-textarea';
    const radios = Array.from(form.querySelectorAll('input[name="answer_config_upload_type"]'));
    const editor = radios.find((r) => String(r.value).toLowerCase() === 'editor') || radios[0];
    if (editor && !editor.checked) {
      editor.checked = true;
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const sel = form.querySelector('select[name="answer_input_test_language"]') || form.querySelector('select');
    if (sel) {
      const want = ${js(lang)};
      const norm = (s) => String(s || '').toLowerCase().replace(/\\s+/g, '');
      let best = null, loose = null;
      Array.from(sel.options).forEach((o) => {
        const t = norm(o.textContent);
        if (!best && t === norm(want)) best = o;
        if (!loose && (t.includes(norm(want)) || norm(want).includes(t))) loose = o;
      });
      const pick = best || loose;
      if (pick) {
        sel.value = pick.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const d = Object.getOwnPropertyDescriptor(ta.constructor.prototype, 'value');
    if (d && d.set) d.set.call(ta, ${js(code)}); else ta.value = ${js(code)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  if (res !== 'ok') throw new Error('提交表单异常: ' + res);

  // 真实点击 Submit 按钮（表单 submit 不带头部按钮字段，UOJ 不认）
  try {
    await evaluate(`(() => {
      const btn = document.querySelector('#button-submit-answer') ||
        document.querySelector('#form-answer button[type="submit"], #form-answer input[type="submit"]');
      if (btn) { btn.click(); return 'clicked'; }
      const form = document.querySelector('#form-answer');
      if (form) { HTMLFormElement.prototype.submit.call(form); return 'native'; }
      return 'none';
    })()`);
  } catch (e) {
    // 点击后页面开始跳转，执行上下文会被销毁，属正常
  }
  dbg('已提交 ' + problemId + ' / ' + lang);

  // 提交后 UOJ 会跳到 /submissions（列表）或 /submission/{id}
  const until = Date.now() + 40000;
  while (Date.now() < until) {
    await sleep(500);
    let href = '';
    try { href = String(await evaluate('location.href')); } catch (e) { }
    const m = /\/submission\/(\d+)/.exec(href);
    if (m) { dbg('提交成功 #' + m[1]); return { submissionId: m[1] }; }
    if (/\/submissions(\?|$)/.test(href)) {
      let first = '';
      try {
        first = String(await evaluate(`(() => { const a = document.querySelector('a[href^="/submission/"]'); return a ? a.getAttribute('href') : ''; })()`));
      } catch (e) { }
      const mm = /\/submission\/(\d+)/.exec(first);
      if (mm) { dbg('提交成功 #' + mm[1]); return { submissionId: mm[1] }; }
    }
  }
  const t = await text();
  throw new Error('提交后没有拿到 submission id' + (t ? '（页面提示：' + t.slice(0, 160).replace(/\s+/g, ' ') + '）' : ''));
}

/* ---------------- 评测结果 ---------------- */

const SCORE_CODES = {
  AC: 'Accepted',
  WA: 'Wrong Answer',
  TLE: 'Time Limit Exceeded',
  MLE: 'Memory Limit Exceeded',
  RE: 'Runtime Error',
  CE: 'Compilation Error',
  PE: 'Presentation Error',
  OLE: 'Output Limit Exceeded',
  ILE: 'Idleness Limit Exceeded',
  UKE: 'Unknown Error',
  JF: 'Judgement Failed',
  SE: 'System Error',
  HACKED: 'Hacked'
};

// QOJ 的提交结果只在这一行的分数单元格里（a.uoj-score，内容是 AC / WA / TLE 这样的短码，
// 通过时还带一个 ✓，分数放在 data-score）。不能整页找关键字：页面上还有状态筛选下拉框，
// 里面列着 Accepted、Wrong Answer 等全部选项，按整页文本匹配会把任何提交都判成 Accepted。
function verdictFromCode(code, score) {
  const raw = String(code || '').trim();
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const sc = String(score == null ? '' : score).trim();
  if (c && SCORE_CODES[c]) return SCORE_CODES[c];
  if (sc !== '' && !isNaN(Number(sc))) return Number(sc) >= 100 ? 'Accepted' : 'Wrong Answer';
  if (!c) return '';
  if (/^\d+$/.test(c)) return Number(c) >= 100 ? 'Accepted' : 'Wrong Answer';
  if (/JUDG|COMPIL|RUNNING|WAITING/.test(c)) return 'Judging';
  return raw;
}

function verdictOf(t) {
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
    ['System Error', 'System Error'],
    ['Waiting', 'Waiting'],
    ['Queued', 'Waiting'],
    ['Compiling', 'Compiling'],
    ['Running', 'Running'],
    ['Judging', 'Judging']
  ];
  for (const [needle, v] of table) if (t.includes(needle)) return v;
  return '';
}

const READ_SCORE_JS = [
  '(function () {',
  '  var sid = window.__vpbSid;',
  '  var rows = Array.prototype.slice.call(document.querySelectorAll("tr"));',
  '  var row = null;',
  '  for (var i = 0; i < rows.length; i++) {',
  '    var links = rows[i].querySelectorAll("a[href*=\'/submission/\']");',
  '    for (var j = 0; j < links.length; j++) {',
  '      var href = links[j].getAttribute("href") || "";',
  '      if (href.indexOf("/submission/" + sid) >= 0 && (links[j].textContent || "").indexOf("#" + sid) >= 0) { row = rows[i]; break; }',
  '    }',
  '    if (row) break;',
  '  }',
  '  function readCell(r) {',
  '    var score = r.querySelector("a.uoj-score");',
  '    if (score) return { code: (score.textContent || "").trim(), score: score.getAttribute("data-score") || "" };',
  '    var tds = r.querySelectorAll("td");',
  '    if (tds.length > 3) return { code: (tds[3].textContent || "").trim(), score: "" };',
  '    return { code: "", score: "" };',
  '  }',
  '  if (row) return JSON.stringify(readCell(row));',
  '  var any = document.querySelector("a.uoj-score");',
  '  if (any) return JSON.stringify({ code: (any.textContent || "").trim(), score: any.getAttribute("data-score") || "" });',
  '  return "";',
  '})()'
].join('\n');

// 逐个测试点的结果：QOJ 在 #details_details_accordion 里为每个测试点渲染一张 card，
// 头部依次是 Test #N / score: X / 判定（Accepted、Wrong Answer…）。
// ICPC 赛制只要有一个测试点不是 Accepted 就算这题没过，所以要找出第一个失败的测试点。
const READ_TESTS_JS = [
  '(function () {',
  '  var wrap = document.querySelector("#details_details_accordion");',
  '  if (!wrap) return "[]";',
  '  var cards = Array.prototype.slice.call(wrap.querySelectorAll(".card"));',
  '  var out = cards.map(function (c) {',
  '    var head = c.querySelector(".card-header .row") || c.querySelector(".card-header");',
  '    var cols = head ? Array.prototype.slice.call(head.querySelectorAll("div")).map(function (d) { return (d.textContent || "").replace(/\\s+/g, " ").trim(); }) : [];',
  '    return { label: cols[0] || "", score: cols[1] || "", verdict: cols[2] || "", cls: c.className };',
  '  });',
  '  return JSON.stringify(out);',
  '})()'
].join('\n');

function firstFailedTest(tests) {
  for (const t of tests) {
    const v = String(t.verdict || '').trim();
    if (!v) continue;
    if (/^Accepted$/i.test(v)) continue;
    if (/^Skipped/i.test(v)) continue;
    return t;
  }
  return null;
}

const PAGE_STATE_JS =
  "JSON.stringify({t:document.title||'',s:!!document.querySelector('a.uoj-score'),c:(document.querySelectorAll('#details_details_accordion .card')||[]).length})";

// 等结果页真正渲染出来。QOJ 在 Cloudflare 后面，偶尔会先给一个「请稍候…」的验证页，
// 这时既没有分数单元格也没有测试点列表，直接读会得到空结果（表现就是「Unknown」）。
async function waitResultPage(timeoutMs) {
  const until = Date.now() + (timeoutMs || 25000);
  let last = null;
  while (Date.now() < until) {
    try {
      const raw = await evaluate(PAGE_STATE_JS);
      last = JSON.parse(raw || '{}');
      if (last && (last.s || last.c)) return last;
    } catch (e) { }
    await sleep(500);
  }
  return last;
}

async function submission(id) {
  if (!browser) await connect();
  const sid = String(id || '').replace(/[^\d]/g, '');
  if (!sid) throw new Error('缺少 submission id');

  let page = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await goto(ORIGIN + '/submission/' + sid);
    page = await waitResultPage(25000);
    if (page && (page.s || page.c)) break;
    dbg('结果页未就绪（' + ((page && page.t) || '未知页面') + '），重试' + (attempt === 0 ? '' : '仍失败'));
    if (attempt === 0) await sleep(1500);
  }

  await evaluate('window.__vpbSid = ' + JSON.stringify(sid));
  const raw = await evaluate(READ_SCORE_JS);
  let info = null;
  try { info = JSON.parse(raw || 'null'); } catch (e) { info = null; }

  let tests = [];
  try {
    const rawTests = await evaluate(READ_TESTS_JS);
    tests = JSON.parse(rawTests || '[]');
  } catch (e) { tests = []; }

  const pending = /Waiting|Compiling|Running|Judging/i;
  const rowCode = info && info.code ? String(info.code).trim() : '';
  const rowVerdict = rowCode ? verdictFromCode(rowCode, info ? info.score : '') : '';

  // ICPC 赛制：任何一个测试点不是 Accepted，这次提交就算没过，原因取第一个失败的测试点。
  let verdict = '';
  let failedTest = null;
  if (tests.length) {
    failedTest = firstFailedTest(tests);
    verdict = failedTest ? (verdictFromCode(failedTest.verdict) || 'Wrong Answer') : 'Accepted';
  } else {
    verdict = rowVerdict;
  }
  if (pending.test(rowVerdict)) verdict = rowVerdict;

  const final = !!verdict && !pending.test(verdict);
  dbg('查询 #' + sid + ' → ' + (verdict || '未知') +
    (failedTest ? '（' + failedTest.label + ' ' + failedTest.verdict + '）' : '') +
    (rowCode ? '，行内 ' + rowCode : '') + '，测试点 ' + tests.length);
  return {
    id: sid,
    status: verdict || 'Unknown',
    verdict: verdict || '',
    code: rowCode,
    score: (info && info.score ? info.score : ''),
    final: !!final
  };
}

async function status() {
  let hasSession = false;
  try { hasSession = fs.existsSync(SESSION_FILE); } catch (e) { hasSession = false; }
  if (!browser || !browser.ws || browser.ws.readyState !== 1) {
    return { loggedIn: false, user: '', url: '', browser: 'stopped', hasSession: hasSession };
  }
  try {
    if (await isLoggedIn()) {
      const href = await profileHref();
      const who = href ? decodeURIComponent(href.split('/').pop() || '') : (state.user || '');
      if (who) state = { loggedIn: true, user: who };
    } else if (state.loggedIn) {
      state = { loggedIn: false, user: '' };
    }
  } catch (e) { }
  let url = '';
  try { url = String((await evaluate('location.href')) || ''); } catch (e) { }
  return { loggedIn: state.loggedIn, user: state.user, url: url, browser: 'running', hasSession: hasSession };
}

function close() {
  try { if (browser && browser.ws) browser.ws.close(); } catch (e) { }
  try { if (edgeProc) edgeProc.kill(); } catch (e) { }
  browser = null;
  edgeProc = null;
  windowHidden = false;
  restored = false;
  state = { loggedIn: false, user: '' };
  /* 临时 profile 用完即删：不留任何浏览器缓存 */
  try { removeDir(PROFILE); } catch (e) { }
  setTimeout(() => {
    try { removeDir(PROFILE); } catch (e) { }
  }, 1500);
}

/* 进程被强杀时可能留下临时目录：按名字里的 pid 判断进程是否还在，
   不在就删；另外把超过一天的一并清掉。 */
function cleanupStaleProfiles() {
  try {
    const base = os.tmpdir();
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const name of fs.readdirSync(base)) {
      const m = /^vpb-qoj-(\d+)$/.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      const full = path.join(base, name);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
      let old = false;
      try { old = fs.statSync(full).mtimeMs < cutoff; } catch (e) { }
      if (alive && !old) continue;
      try { removeDir(full); dbg('清理残留配置目录: ' + name); } catch (e) { }
    }
  } catch (e) { }
}

module.exports = { login, logout, problems, editorials, contests, submit, submission, status, close, log, normalizeLang, verdictOf, connect, evaluate, goto, waitFor };
