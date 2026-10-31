/* 单元测试：用真实抓取的数据验证归一化、时间缩放、排名与封榜 */
const fs = require('fs');
const path = require('path');
const VP = require('../assets/core.js');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

let failures = 0;
function ok(cond, msg, extra) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const dir = path.join(__dirname, '..', 'fixtures', 'icpc_50th_nanjing');
const config = readJson(path.join(dir, 'config.json'));
const teams = readJson(path.join(dir, 'team.json'));
const runs = readJson(path.join(dir, 'run.json'));

console.log('— 归一化 —');
const ds = VP.buildDataset({ config, teams, runs });
ok(ds.contest.durationMs === 5 * 3600 * 1000, '比赛时长 5h', ds.contest.durationMs);
ok(ds.problems.length === 13, '13 道题', ds.problems.length);
ok(ds.teams.length === 359, '359 支队伍', ds.teams.length);
ok(ds.runs.length > 3900, '提交数 > 3900', ds.runs.length);
ok(ds.runs.every(r => r.p >= 0 && r.p < 13), '所有提交题目下标合法');
ok(ds.contest.penaltyMin === 20, '罚时 20 分钟/次', ds.contest.penaltyMin);
ok(ds.contest.frozenMs === 3600 * 1000, '封榜 1 小时', ds.contest.frozenMs);

const acPairs = new Set();
ds.runs.forEach(r => { if (r.st === 'AC') acPairs.add(r.teamId + '|' + r.p); });

console.log('— 5 小时模式 —');
const viewFull = VP.buildView(ds, 'full');
ok(Math.abs(viewFull.virtualDuration - 5 * 3600e3) < 1, '虚拟时长 = 5h', viewFull.virtualDuration);
ok(Math.abs(viewFull.freezeStart - 4 * 3600e3) < 1, '封榜起点 = 4:00:00', viewFull.freezeStart);
const endFull = VP.computeStandings(viewFull, viewFull.virtualDuration, false);
const solvedSum = endFull.rows.reduce((a, r) => a + r.solved, 0);
ok(solvedSum === acPairs.size, '完赛后总过题数 = 去重 AC 数', [solvedSum, acPairs.size]);

for (let i = 1; i < endFull.rows.length; i++) {
  const a = endFull.rows[i - 1], b = endFull.rows[i];
  const good = a.solved > b.solved ||
    (a.solved === b.solved && a.penalty < b.penalty) ||
    (a.solved === b.solved && a.penalty === b.penalty && a.lastAc <= b.lastAc);
  if (!good) { ok(false, '排名单调 @' + i, [a.team.name, a.solved, a.penalty, b.team.name, b.solved, b.penalty]); break; }
}
ok(true, '排名单调（过题↓ 罚时↑ 最后过题↑）');
ok(endFull.rows[0].rank === 1 && endFull.rows[endFull.rows.length - 1].rank === endFull.rows.length, '名次连续');
const firstOfficial = endFull.rows.find(r => r.team.official);
ok(firstOfficial && firstOfficial.medal === 'gold', '首位正式队伍金牌', firstOfficial && firstOfficial.medal);
ok(endFull.rows.filter(r => !r.team.official).every(r => !r.medal), '打星队伍不参与奖牌');
const medalRows = endFull.rows.filter(r => r.medal);
ok(medalRows.every(r => r.team.official), '奖牌只发给正式队伍');
ok(endFull.rows.some(r => r.tierStart === 'silver'), '有银牌分界标记');

console.log('— 3 小时模式 —');
const view3 = VP.buildView(ds, '3h');
ok(Math.abs(view3.scale - 0.6) < 1e-9, '缩放系数 0.6', view3.scale);
ok(Math.abs(view3.virtualDuration - 3 * 3600e3) < 1, '虚拟时长 = 3h', view3.virtualDuration);
ok(Math.abs(view3.freezeStart - (3 * 3600e3 - 36 * 60e3)) < 1, '封榜起点 = 2:24:00', view3.freezeStart);
ok(Math.abs((view3.virtualDuration - view3.freezeStart) - 36 * 60e3) < 1, '封榜时长 = 36 分钟');

console.log('— 时间映射曲线 —');
const tm = view3.timeMap;
ok(!!tm && typeof tm.toVirtual === 'function', '时间映射可用');
ok(Math.abs(tm.toVirtual(0)) < 1, '映射 f(0) = 0');
ok(Math.abs(tm.toVirtual(5 * 3600e3) - 3 * 3600e3) < 1, '映射 f(5h) = 3h');
ok(Math.abs(tm.toVirtual(4 * 3600e3) - view3.freezeStart) < 1, '映射 f(4:00) = 封榜点');
ok(Math.abs(tm.toVirtual(5 * 60e3) - 5 * 60e3) < 15e3, '开场 5 分钟几乎原样出现', VP.fmtClock(tm.toVirtual(5 * 60e3)));
{
  const oneH = tm.toVirtual(3600e3);
  ok(oneH > 50 * 60e3 && oneH < 58 * 60e3, '1:00 的题出现在 50–58 分钟之间', VP.fmtClock(oneH));
  let mono = true;
  for (let i = 1; i <= 200; i++) {
    if (tm.toVirtual(i * 5 * 3600e3 / 200) < tm.toVirtual((i - 1) * 5 * 3600e3 / 200) - 1) mono = false;
  }
  ok(mono, '映射单调不减');
  let invErr = 0;
  for (let i = 0; i <= 100; i++) {
    const r = i * 5 * 3600e3 / 100;
    invErr = Math.max(invErr, Math.abs(tm.toReal(tm.toVirtual(r)) - r));
  }
  ok(invErr < 1000, '反函数往返误差 < 1 秒', invErr);
}

// 任取一个 5 小时附近通过的提交（同一队同一题最早的一次 AC），验证 3 小时模式下的出现时刻符合曲线
const firstAc = new Map();
ds.runs.forEach(r => { if (r.st === 'AC') { const k = r.teamId + '|' + r.p; if (!firstAc.has(k)) firstAc.set(k, r); } });
const lateAc = Array.from(firstAc.values()).filter(r => r.realTs > 4.9 * 3600e3).sort((a, b) => b.realTs - a.realTs)[0];
ok(!!lateAc, '存在 4:54 之后首次通过的提交', lateAc && lateAc.realTs);
if (lateAc) {
  const team = ds.teams.find(t => t.id === lateAc.teamId);
  const atEnd = VP.computeStandings(view3, view3.virtualDuration, false).rows.find(r => r.team.id === lateAc.teamId);
  const cell = atEnd.cells[lateAc.p];
  ok(cell.state === 'AC', '3h 模式结束时该题通过', cell);
  ok(cell.minutes === Math.floor(lateAc.realTs / 60000), '罚时用原时间', [cell.minutes, lateAc.realTs]);
  if (cell.state === 'AC') {
    console.log('    ' + team.name + '  ' + ds.problems[lateAc.p].label + '  原 ' + VP.fmtClock(lateAc.realTs) + ' → 虚拟 ' + VP.fmtClock(cell.t));
    ok(Math.abs(cell.t - tm.toVirtual(lateAc.realTs)) < 1, '虚拟出现时刻 = 曲线映射值');
  }
}

// 全量校验：每个 (队伍,题) 的首个 AC 在 3h 模式里都出现在 0.6 倍时刻
{
  let bad = 0, checked = 0;
  const rowsById = new Map(VP.computeStandings(view3, view3.virtualDuration, false).rows.map(r => [r.team.id, r]));
  for (const [k, run] of firstAc) {
    const row = rowsById.get(run.teamId);
    const cell = row && row.cells[run.p];
    checked++;
    if (!cell || cell.state !== 'AC' || Math.abs(cell.t - tm.toVirtual(run.realTs)) > 1) bad++;
  }
  ok(bad === 0, '全部 ' + checked + ' 个首次 AC 的虚拟时刻都精确缩放', bad);
}

// 封榜可见性：3h 模式下 2:24 之后不再显示新过题
const t = view3.freezeStart + 60 * 60e3;
const frozenStand = VP.computeStandings(view3, t, true);
const lateSolves = frozenStand.rows.filter(r => r.cells.some(c => c.state === 'AC' && c.t > t));
ok(lateSolves.length === 0, '封榜后不暴露新过题', lateSolves.length);
const fz = frozenStand.rows.filter(r => r.cells.some(c => c.state === 'FZ')).length;
ok(fz > 0, '封榜期有队伍显示 ? 格子', fz);

// 与原数据对比：封榜后（4:00 之后）的 AC 在 3h 模式下 2:24 之后同样被隐藏
const postFreezeAc = ds.runs.filter(r => r.st === 'AC' && r.realTs > 4 * 3600e3);
const preFreezeView = VP.computeStandings(view3, view3.freezeStart - 1000, false);
const postFreezeView = VP.computeStandings(view3, view3.virtualDuration, false);
const gained = postFreezeView.rows.reduce((a, r) => a + r.solved, 0) - preFreezeView.rows.reduce((a, r) => a + r.solved, 0);
ok(gained > 0, '后半程仍有 ' + gained + ' 个过题（封榜揭晓后）', gained);
console.log('    封榜后原始 AC 数: ' + postFreezeAc.length);

console.log('— 新格式兼容 —');
const newConfig = {
  contest_name: 'Test Contest', start_time: 1762651800000, end_time: 1762669800000,
  penalty: 1200, frozen_time: 3600,
  problems: [{ id: '0', label: 'A' }, { id: '1', label: 'B' }],
  medal: { official: { gold: 1, silver: 2, bronze: 3 } },
  options: { submission_timestamp_unit: 'millisecond' }
};
const newTeams = { t1: { team_id: 't1', name: 'Alpha', official: true }, t2: { team_id: 't2', name: 'Beta', official: true } };
const newRuns = [
  { team_id: 't1', problem_id: '0', timestamp: 600000, status: 'correct' },
  { team_id: 't1', problem_id: '0', timestamp: 300000, status: 'incorrect' },
  { team_id: 't2', problem_id: '1', timestamp: 1200000, status: 'pending' }
];
const ds2 = VP.buildDataset({ config: newConfig, teams: newTeams, runs: newRuns });
ok(ds2.problems.length === 2, '新格式题目 2 道');
ok(ds2.teams.length === 2 && ds2.teams[0].official, '新格式队伍 official 标记');
ok(ds2.runs[1].st === 'AC' && ds2.runs[1].p === 0, '新格式 correct → AC');
ok(ds2.runs[0].st === 'WA', '新格式 incorrect → WA');
const st2 = VP.computeStandings(VP.buildView(ds2, '3h'), 3 * 3600e3, false);
ok(st2.rows[0].team.name === 'Alpha' && st2.rows[0].solved === 1, '新格式排名');
ok(st2.rows[0].penalty === 10 + 20, '新格式罚时 = 10 + 20', st2.rows[0].penalty);
ok(st2.rows[0].medal === 'gold', '奖牌线生效');

console.log(failures === 0 ? '\n全部通过 ✓' : '\n失败 ' + failures + ' 项 ✗');
process.exit(failures === 0 ? 0 : 1);
