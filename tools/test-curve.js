/* 离线检查帮助里的时间曲线：用最小 DOM 桩跑一遍 renderTimeCurve，确认 SVG 正常。
   node tools/test-curve.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');

const nodes = {};
function stub(sel) {
  if (!nodes[sel]) {
    nodes[sel] = {
      sel: sel,
      innerHTML: '',
      textContent: '',
      dataset: {},
      hidden: false,
      checked: false,
      value: '',
      style: {},
      className: '',
      children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      removeEventListener() {},
      appendChild() {},
      remove() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 560, height: 190 }; },
      setAttribute() {}
    };
  }
  return nodes[sel];
}

const document = {
  documentElement: { dataset: {} },
  querySelector: stub,
  querySelectorAll() { return []; },
  getElementById() { return null; },
  createElement() { return stub('el'); },
  addEventListener() {}
};
const window = {
  document,
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  location: { search: '', href: 'http://127.0.0.1:8787/' },
  navigator: { userAgent: 'node' },
  screen: { availWidth: 1920, availHeight: 1080 },
  setTimeout() { return 0; },
  clearTimeout() {},
  setInterval() { return 0; },
  clearInterval() {},
  fetch() { return Promise.reject(new Error('no net')); },
  URLSearchParams,
  console
};
window.window = window;

const ctx = vm.createContext(window);
ctx.window = window;
ctx.document = document;
ctx.localStorage = window.localStorage;
ctx.setTimeout = window.setTimeout;
ctx.clearTimeout = window.clearTimeout;
ctx.URLSearchParams = URLSearchParams;

for (const f of ['assets/core.js', 'assets/app.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}

const payload = {
  config: JSON.parse(fs.readFileSync(path.join(root, 'fixtures/icpc_50th_nanjing/config.json'), 'utf8')),
  teams: JSON.parse(fs.readFileSync(path.join(root, 'fixtures/icpc_50th_nanjing/team.json'), 'utf8')),
  runs: JSON.parse(fs.readFileSync(path.join(root, 'fixtures/icpc_50th_nanjing/run.json'), 'utf8'))
};
const VP = window.VP;
const ds = VP.buildDataset(payload);
const app = window.VPApp;
app.state.dataset = ds;
app.state.view = VP.buildView(ds, '3h');
app.state.mode = '3h';

app.renderTimeCurve(null);
const svg = nodes['#tcSvg'];
const html = svg.innerHTML;
const checks = [
  ['有曲线', /class="tc-curve"/.test(html)],
  ['有 161 个采样点', (html.match(/[0-9.]+,[0-9.]+/g) || []).length >= 161],
  ['有封榜线', /tc-freeze/.test(html)],
  ['有坐标文字', /class="tc-tick"/.test(html)]
];
console.log('tips:', nodes['#tcTip'].textContent);

app.renderTimeCurve(2 * 3600e3);
const hover = nodes['#tcSvg'].innerHTML;
checks.push(['悬停有标记', /tc-hover/.test(hover) && /tc-dot/.test(hover)]);
console.log('hover tip:', nodes['#tcTip'].textContent);

let bad = 0;
for (const [name, good] of checks) { if (!good) bad++; console.log((good ? '  ok ' : '  FAIL ') + name); }

/* 反函数：2:00 对应的原始时刻应该 ≈ 2:52 */
const tm = app.state.view.timeMap;
const back = tm.toReal(tm.toVirtual(2 * 3600e3 + 52 * 60e3));
console.log('往返 2:52 → ' + VP.fmtClock(back));
process.exit(bad ? 1 : 0);
