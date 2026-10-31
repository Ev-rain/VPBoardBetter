/* 自绘标题栏测试：/api/frame 代理（Task 1）、标题条结构（Task 2）、页面交互（Task 3） */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FRAME_PORT = 8790;
const APP_PORT = 8793;

let failures = 0;
function ok(cond, msg, extra) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
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
    } catch (e) {}
    await sleep(150);
  }
  return false;
}

async function main() {
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

  console.log(failures === 0 ? '\n全部通过 ✓' : '\n失败 ' + failures + ' 项 ✗');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
