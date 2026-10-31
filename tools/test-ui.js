/* 页面结构与本地服务自检：不跑浏览器，只查静态文件与接口。
   用法：node tools/test-ui.js  */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  ok  ' + name); return; }
  failed++;
  console.log('  FAIL ' + name + (extra ? '  (' + extra + ')' : ''));
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function get(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

(async function main() {
  const html = read('index.html');
  const css = read('assets/style.css');
  const app = read('assets/app.js');
  const srv = read('server.js');

  console.log('静态结构');
  ok('index.html 没有旧的自绘标题条', html.indexOf('id="titlebar"') < 0 && html.indexOf('tb-btn') < 0);
  ok('index.html 有页面容器与品牌位', html.indexOf('id="app"') >= 0 && html.indexOf('class="brand"') >= 0);
  ok('style.css 不再有 .titlebar / body.framed', css.indexOf('.titlebar') < 0 && css.indexOf('body.framed') < 0);
  ok('style.css 有 .hosted .brand 规则', css.indexOf('.hosted .brand') >= 0);
  ok('app.js 支持 ?host=1 → body.hosted', app.indexOf("qs.get('host') === '1'") >= 0 && app.indexOf("classList.add('hosted')") >= 0);
  ok('app.js 不再含 frame 客户端代码', !/initFrame|frameCmd|frameState/.test(app));
  ok('server.js 不再有 /api/frame', srv.indexOf('/api/frame') < 0 && srv.indexOf('frameCall') < 0);

  console.log('本地服务');
  const port = 8794;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: 'ignore'
  });
  let health = null;
  for (let i = 0; i < 40; i++) {
    const r = await get(port, '/api/health');
    if (r.status === 200) { health = r; break; }
    await new Promise((r2) => setTimeout(r2, 150));
  }
  ok('/api/health 返回 200', !!(health && health.status === 200), health && health.body);
  if (health) {
    let j = {};
    try { j = JSON.parse(health.body); } catch (e) { }
    ok('health.features 不含 frame', Array.isArray(j.features) && j.features.indexOf('frame') < 0);
    ok('health 带 build 与 qoj 字段', !!j.build && j.qoj === true);
  }
  const frame = await get(port, '/api/frame/state');
  ok('旧 /api/frame/state 已 404', frame.status === 404, 'status=' + frame.status);
  const home = await get(port, '/');
  ok('首页 200 且含 app 容器', home.status === 200 && home.body.indexOf('id="app"') >= 0);

  child.kill();
  console.log(failed ? ('\n失败 ' + failed + ' 项') : '\n全部通过 ✓');
  process.exit(failed ? 1 : 0);
})();
