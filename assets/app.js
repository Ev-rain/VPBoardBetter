/* ============================================================
   app.js — 界面、回放时钟、榜单渲染、我的队伍与 QOJ 交互
   ============================================================ */
(function () {
  'use strict';

  var VP = window.VP;

  /* 任何脚本异常都留个痕迹（截图/排障时能看见） */
  window.addEventListener('error', function (e) {
    try {
      document.documentElement.dataset.error = String(e.message || e.type || 'error');
      var s = document.getElementById('statusLeft');
      if (s) s.textContent = '脚本错误：' + (e.message || e.type);
    } catch (err) { /* ignore */ }
  });
  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e.reason || {};
      document.documentElement.dataset.error = 'promise: ' + (r.message || r);
    } catch (err) { /* ignore */ }
  });

  /* ---------------- 小工具 ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  var toastTimer = [];
  function toast(msg, type) {
    var box = $('#toasts');
    var t = el('div', 'toast ' + (type || ''));
    t.textContent = msg;
    box.appendChild(t);
    var timer = setTimeout(function () {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      setTimeout(function () { t.remove(); }, 260);
    }, type === 'err' ? 6000 : 3200);
    toastTimer.push(timer);
    while (box.children.length > 4) box.firstChild.remove();
  }

  /* ---------------- 状态 ---------------- */
  var PREF_KEY = 'xcpciovp.prefs.v1';
  var MY_KEY = 'xcpciovp.my.v1';

  var state = {
    dataset: null,
    view: null,
    standings: null,
    source: '',
    key: '',
    mode: 'full',
    playing: false,
    elapsed: 0,
    finished: false,
    frozen: false,
    search: '',
    officialOnly: false,
    showMedals: true,
    selected: null,
    myTeam: null,
    myRuns: [],
    qoj: { available: false, loggedIn: false, user: '', byContest: {}, languages: [], pageUrl: '', lastProblemList: [] },
    rowCache: new Map(),
    lastRender: 0,
    lastFrame: 0,
    dragging: false
  };

  var els = {};

  /* ---------------- 持久化 ---------------- */
  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (p.mode === 'full' || p.mode === '3h') state.mode = p.mode;
      if (typeof p.officialOnly === 'boolean') state.officialOnly = p.officialOnly;
      if (typeof p.showMedals === 'boolean') state.showMedals = p.showMedals;
      return p;
    } catch (e) { return {}; }
  }

  var saveTimer = null;
  function savePrefs(extra) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var p = {
          mode: state.mode,
          officialOnly: state.officialOnly, showMedals: state.showMedals,
          contestPath: state.contestInput || '', elapsed: state.elapsed, key: state.key
        };
        if (extra) Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
        localStorage.setItem(PREF_KEY, JSON.stringify(p));
      } catch (e) { /* ignore */ }
    }, 350);
  }

  function loadMy(key) {
    try {
      var all = JSON.parse(localStorage.getItem(MY_KEY) || '{}');
      var rec = all[key];
      if (!rec) return null;
      return { team: rec.team || null, runs: Array.isArray(rec.runs) ? rec.runs : [] };
    } catch (e) { return null; }
  }

  function saveMy() {
    if (!state.key) return;
    try {
      var all = JSON.parse(localStorage.getItem(MY_KEY) || '{}');
      if (!state.myTeam && !state.myRuns.length) delete all[state.key];
      else all[state.key] = { team: state.myTeam, runs: state.myRuns };
      localStorage.setItem(MY_KEY, JSON.stringify(all));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 时间轴 ---------------- */
  function finish() {
    state.finished = true;
    state.playing = false;
    state.frozen = false;
    state.elapsed = state.view ? state.view.virtualDuration : 0;
    updatePlayButton();
    ensureEditorial();
  }

  function restart() {
    state.elapsed = 0;
    state.finished = false;
    state.playing = false;
    state.frozen = false;
    updatePlayButton();
    updateClock();
    renderBoard(true);
  }

  function setPlaying(v) {
    if (!state.view) return;
    if (v && state.finished) restart();
    state.playing = !!v;
    state.lastFrame = 0;
    updatePlayButton();
  }

  function updatePlayButton() {
    els.btnPlay.classList.toggle('playing', state.playing);
    els.btnPlay.title = state.playing ? '暂停（空格）' : '播放（空格）';
  }

  function updateClock() {
    if (!state.view) {
      els.clockMain.textContent = '00:00:00';
      els.clockSub.textContent = '/ 00:00:00';
      return;
    }
    var V = state.view.virtualDuration;
    var e = clamp(state.elapsed, 0, V);
    els.clockMain.textContent = VP.fmtClock(e);
    els.clockSub.textContent = '/ ' + VP.fmtClock(V);

    var f = V > 0 ? e / V : 0;
    els.timelineFill.style.width = (f * 100) + '%';
    els.timelineKnob.style.left = (f * 100) + '%';

    var fs = state.view.freezeStart;
    if (fs > 0 && fs < V) {
      els.freezeZone.hidden = false;
      els.freezeZone.style.left = (fs / V * 100) + '%';
      els.freezeZone.style.width = ((V - fs) / V * 100) + '%';
    } else {
      els.freezeZone.hidden = true;
    }

    // 封榜状态
    var frozen = !state.finished && fs > 0 && e >= fs && e < V;
    if (frozen !== state.frozen) {
      state.frozen = frozen;
      renderBoard(true);
    }
    if (frozen) {
      els.freezeBadge.hidden = false;
      els.freezeBadge.className = 'badge badge-freeze';
      els.freezeBadge.textContent = '封榜中 · 还剩 ' + VP.fmtClock(Math.max(0, V - e));
    } else if (state.finished) {
      els.freezeBadge.hidden = false;
      els.freezeBadge.className = 'badge badge-end';
      els.freezeBadge.textContent = '已结束 · 榜单已揭晓';
    } else {
      els.freezeBadge.hidden = true;
    }
    updateEditorialBtn();
  }

  function seekTo(ms) {
    if (!state.view) return;
    var V = state.view.virtualDuration;
    state.elapsed = clamp(ms, 0, V);
    if (state.elapsed >= V) { finish(); }
    else { state.finished = false; }
    updateClock();
    renderBoard(true);
    savePrefs();
  }

  function seekFrac(f) { seekTo(f * state.view.virtualDuration); }

  function tick(ts) {
    requestAnimationFrame(tick);
    if (!state.view) return;
    if (state.playing) {
      if (!state.lastFrame) state.lastFrame = ts;
      var dt = clamp(ts - state.lastFrame, 0, 300);
      state.lastFrame = ts;
      state.elapsed += dt;
      if (state.elapsed >= state.view.virtualDuration) {
        finish();
        renderBoard(true);
      } else {
        updateClock();
        if (ts - state.lastRender > 90) renderBoard(false);
      }
      savePrefs();
    } else {
      state.lastFrame = 0;
    }
  }

  /* ---------------- 数据载入 ---------------- */
  function applyPayload(payload) {
    var ds = VP.buildDataset(payload);
    state.dataset = ds;
    state.source = payload.source || '';
    state.contestInput = payload.input || state.source;
    state.key = state.source || ds.contest.name;
    state.selected = null;

    // 恢复“我的队伍”
    var my = loadMy(state.key);
    state.myTeam = my && my.team ? my.team : null;
    state.myRuns = my && my.runs ? my.runs : [];
    if (state.myTeam && state.myTeam.id && ds.teams.some(function (t) { return t.id === state.myTeam.id; })) {
      state.myTeam.fixed = true;
    }
    ds.myTeam = state.myTeam;
    ds.myRuns = state.myRuns;

    state.elapsed = 0;
    state.finished = false;
    state.playing = false;
    state.frozen = false;
    state.myTeamId = state.myTeam ? state.myTeam.id : null;
    rebuildView();
    updateTicks();

    els.emptyState.hidden = true;
    els.board.hidden = false;
    els.drawer.hidden = true;
    els.drawer.classList.remove('open');

    updateHeader();
    buildTableHeader();
    state.rowCache.clear();
    els.tbody.innerHTML = '';
    updatePlayButton();
    updateClock();
    editorialShown = null;
    updateEditorialBtn();
    renderBoard(true);
    updateStatus();

    if (!/^示例/.test(state.source)) {
      Data.pushRecent({ path: state.contestInput || state.source, name: ds.contest.name });
    }
    savePrefs();
    saveMy();
    toast('已加载：' + ds.contest.name + '（' + ds.teams.length + ' 队 / ' + ds.runs.length + ' 次提交）', 'ok');
  }

  function rebuildView() {
    if (!state.dataset) return;
    state.myTeamId = state.myTeam ? state.myTeam.id : null;
    state.dataset.myTeam = state.myTeam;
    state.dataset.myRuns = state.myRuns;
    state.view = VP.buildView(state.dataset, state.mode);
    state.frozen = false;
    if (state.view) {
      state.elapsed = clamp(state.elapsed, 0, state.view.virtualDuration);
      var V = state.view.virtualDuration;
      state.frozen = !state.finished && state.view.freezeStart > 0 && state.elapsed >= state.view.freezeStart && state.elapsed < V;
    }
    updateLegendMode();
    updateTicks();
    updateStatus();
  }

  function setMode(mode) {
    if (!state.dataset || state.mode === mode) {
      if (state.dataset) {
        $$('#modeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === state.mode); });
      }
      return;
    }
    var frac = state.view ? state.elapsed / state.view.virtualDuration : 0;
    var wasFinished = state.finished;
    state.mode = mode;
    rebuildView();
    state.elapsed = frac * state.view.virtualDuration;
    if (wasFinished) { state.elapsed = state.view.virtualDuration; state.finished = true; }
    $$('#modeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === mode); });
    updateHeader();
    updateClock();
    renderBoard(true);
    savePrefs();
    if (!$('#helpOverlay').hidden) renderTimeCurve(null);
    toast(mode === '3h' ? '已切换到 3 小时模式 · 开场贴近实时，越往后越快' : '已切换到完整时长模式', '');
  }

  /* ---------------- 顶栏 / 状态栏 ---------------- */
  function updateHeader() {
    if (!state.dataset) return;
    var c = state.dataset.contest;
    els.contestName.textContent = c.name;
    var parts = [];
    parts.push('<b>' + VP.fmtHMS(c.durationMs) + '</b> 时长');
    parts.push('<b>' + state.dataset.teams.length + '</b> 队');
    parts.push('<b>' + state.dataset.problems.length + '</b> 题');
    parts.push('罚时 <b>' + c.penaltyMin + '</b> 分钟');
    if (c.frozenMs > 0) {
      var fm = Math.round(c.frozenMs / 60000);
      var sm = state.mode === '3h' && state.view ? Math.round(c.frozenMs * state.view.scale / 60000) : fm;
      parts.push('封榜 <b>' + fm + (sm !== fm ? '→ ' + sm : '') + '</b> 分钟');
    }
    if (c.medals) parts.push('金银铜 <b>' + c.medals.gold + '/' + c.medals.silver + '/' + c.medals.bronze + '</b>');
    els.contestMeta.innerHTML = parts.join('<span style="opacity:.35">·</span>');
    document.title = c.name + ' · VP Board Better';
  }

  function updateLegendMode() {
    if (!state.view) { els.legendMode.textContent = ''; return; }
    if (state.mode === '3h') {
      els.legendMode.textContent = '3h 模式 · 非线性压缩';
    } else {
      els.legendMode.textContent = '原始时长';
    }
  }

  var lastWinSent = '';

/* 记住窗口大小：把当前外框尺寸报给本地服务，下次启动按它开窗 */
function reportWindowSize() {
  if (!state.qoj.available) return;
  var w = Math.round(window.outerWidth || 0);
  var h = Math.round(window.outerHeight || 0);
  if (w < 900 || h < 600) return;
  var scr = window.screen || {};
  if (scr.availWidth && scr.availHeight &&
      w >= scr.availWidth - 4 && h >= scr.availHeight - 4) return; // 最大化时不记
  var x = Math.round(Number(window.screenX));
  var y = Math.round(Number(window.screenY));
  var sig = w + 'x' + h + '@' + x + ',' + y;
  if (sig === lastWinSent) return;
  lastWinSent = sig;
  fetch('/api/window', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ w: w, h: h, x: x, y: y })
  }).catch(function () { lastWinSent = ''; });
}

function updateStatus() {
    if (!state.dataset) { els.statusLeft.textContent = '未加载数据'; els.statusRight.textContent = ''; return; }
    var c = state.dataset.contest;
    var left = state.dataset.teams.length + ' 队 · ' + state.dataset.runs.length + ' 提交';
    if (state.source) left += ' · ' + (state.source.length > 74 ? state.source.slice(0, 74) + '…' : state.source);
    els.statusLeft.textContent = left;
    var right = [];
    if (c.frozenMs > 0) {
      right.push(state.mode === '3h'
        ? '封榜 ' + Math.round(c.frozenMs / 60000) + ' → ' + Math.round(c.frozenMs * state.view.scale / 60000) + ' 分钟'
        : '封榜 ' + Math.round(c.frozenMs / 60000) + ' 分钟');
    }
    right.push(state.myTeam ? '我的队伍：' + state.myTeam.name : '未设置我的队伍');
    els.statusRight.textContent = right.join(' · ');
  }

  /* ---------------- 榜单渲染 ---------------- */
  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{3}|[a-f\d]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbCss(c) { return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'; }
  function rgbaCss(c, a) { return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }

  function mixRgb(a, b, t) {
    return {
      r: Math.round(a.r + (b.r - a.r) * t),
      g: Math.round(a.g + (b.g - a.g) * t),
      b: Math.round(a.b + (b.b - a.b) * t)
    };
  }

  /** 题目标签配色：暗色气球（尤其黑色）在深色背景上要提亮，保证可读 */
  function problemStyle(hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return { color: '#cfe3f5', background: 'rgba(255,255,255,.06)', borderColor: 'var(--border-soft)' };
    var lum = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    var text = rgb;
    if (lum < 0.5) text = mixRgb(rgb, { r: 255, g: 255, b: 255 }, Math.min(0.78, 0.35 + (0.5 - lum) * 1.1));
    return {
      color: rgbCss(text),
      background: rgbaCss(rgb, lum < 0.2 ? 0.22 : 0.16),
      borderColor: rgbaCss(text, 0.45)
    };
  }

  function buildTableHeader() {
    var ps = state.view.problems;
    var html = '<tr><th class="c-rank">#</th><th class="c-team">队伍</th>' +
      '<th class="c-solved">过题</th><th class="c-penalty">罚时</th>';
    ps.forEach(function (p) {
      var st = problemStyle(p.color);
      var css = 'color:' + st.color + ';background:' + st.background + ';border-color:' + st.borderColor + ';';
      html += '<th class="c-prob" title="' + esc(p.label + (p.title ? ' · ' + p.title : '')) + '">' +
        '<span class="plabel" style="' + css + '">' + esc(p.label) + '</span></th>';
    });
    html += '</tr>';
    els.head.innerHTML = html;
  }

  function rowSignature(row, P) {
    var s = row.rank + '|' + row.solved + '|' + row.penalty + '|' + (row.medal || '') +
      '|' + (row.team.id === state.myTeamId ? 'M' : '') +
      '|' + (state.showMedals ? 1 : 0) + '|' + (state.selected === row.team.id ? 1 : 0);
    for (var i = 0; i < P; i++) {
      var c = row.cells[i];
      s += c.state + (c.attempts || 0) + (c.minutes != null ? c.minutes : '') + ',';
    }
    return s;
  }

  function matchTeam(team, q) {
    if (!q) return true;
    if (team.name && team.name.toLowerCase().indexOf(q) >= 0) return true;
    if (team.org && team.org.toLowerCase().indexOf(q) >= 0) return true;
    if (team.id && team.id.toLowerCase().indexOf(q) >= 0) return true;
    if (team.location && team.location.toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }

  function createRow(row, P) {
    var tr = el('tr');
    tr.dataset.id = row.team.id;

    var tdRank = el('td', 'c-rank');
    var badge = el('span', 'rank-badge');
    tdRank.appendChild(badge);

    var tdTeam = el('td', 'c-team');
    var wrap = el('div', 'team-cell');
    var name = el('span', 'team-name');
    var org = el('span', 'team-org');
    var tags = el('span', 'team-tags');
    wrap.appendChild(name); wrap.appendChild(org); wrap.appendChild(tags);
    tdTeam.appendChild(wrap);

    var tdSolved = el('td', 'c-solved');
    var solved = el('span', 'solved-cell');
    tdSolved.appendChild(solved);

    var tdPen = el('td', 'c-penalty');
    var pen = el('span', 'penalty-cell');
    tdPen.appendChild(pen);

    tr.appendChild(tdRank); tr.appendChild(tdTeam); tr.appendChild(tdSolved); tr.appendChild(tdPen);

    var cells = [];
    for (var i = 0; i < P; i++) {
      var td = el('td', 'p-cell');
      var cs = el('span', 'cell');
      td.appendChild(cs);
      tr.appendChild(td);
      cells.push({ td: td, cell: cs, last: '' });
    }

    return { tr: tr, badge: badge, name: name, org: org, tags: tags, solved: solved, pen: pen, cells: cells, sig: '' };
  }

  function updateRow(rec, row, firstMap) {
    var team = row.team;
    var P = state.view.problems.length;

    rec.tr.className = '';
    if (team.girl) rec.tr.classList.add('girl-row');
    if (state.showMedals && row.medal) rec.tr.classList.add('medal-' + row.medal);
    if (state.showMedals && row.tierStart) rec.tr.classList.add('tier-' + row.tierStart);
    if (team.id === state.myTeamId) rec.tr.classList.add('my-team');
    if (state.selected === team.id) rec.tr.classList.add('selected');

    rec.badge.textContent = row.rank;
    rec.name.textContent = team.name;
    rec.org.textContent = team.org || '';

    var tagHtml = '';
    if (state.showMedals && row.tierStart) tagHtml += '<span class="tag tier ' + row.tierStart + '">' + (row.tierStart === 'silver' ? '银牌线' : '铜牌线') + '</span>';
    if (team.unofficial) tagHtml += '<span class="tag star">' + esc(state.view.contest.unofficialLabel) + '</span>';
    if (team.girl) tagHtml += '<span class="tag girl">女队</span>';
    if (team.id === state.myTeamId) tagHtml += '<span class="tag me">我的队伍</span>';
    if (rec.tags.innerHTML !== tagHtml) rec.tags.innerHTML = tagHtml;

    rec.solved.textContent = row.solved;
    rec.pen.textContent = row.penalty;

    /* 罚时提示：总罚时＋3 小时模式下按压缩后时间算的等价罚时 */
    var penPer = state.view.contest.penaltyMin || 20;
    var scaled = 0;
    for (var q = 0; q < P; q++) {
      var cc = row.cells[q];
      if (cc && cc.state === 'AC') scaled += Math.floor(cc.t / 60000) + (cc.attempts || 0) * penPer;
    }
    var penTitle = '总罚时 ' + row.penalty + ' 分钟 = 各题通过时间之和 + ' + penPer + ' 分钟 × 失败次数';
    if (state.mode === '3h') penTitle += '\n3 小时模式下按压缩后时间换算约 ' + scaled + ' 分钟（每个格子上悬停能看到该题的压缩后时间）';
    var solvedTitle = '过题 ' + row.solved + ' 题' +
      (state.mode === '3h' ? '\n3 小时模式压缩后罚时约 ' + scaled + ' 分钟（罚时列悬停可看明细）' : '');
    var tdSolved = rec.tr.children[2];
    var tdPen = rec.tr.children[3];
    if (tdSolved && tdSolved.title !== solvedTitle) tdSolved.title = solvedTitle;
    if (tdPen && tdPen.title !== penTitle) tdPen.title = penTitle;

    for (var p = 0; p < P; p++) {
      var cell = row.cells[p];
      var c = rec.cells[p];
      var text = '', cls = 'cell', title = '';

      if (cell.state === 'AC') {
        cls = 'cell ac';
        text = String(cell.minutes) + (cell.attempts ? '<span class="a-wrong">+' + cell.attempts + '</span>' : '');
        if (firstMap.get(p) === cell.t) cls += ' first';
        var label2 = state.view.problems[p].label;
        title = label2 + ' 题 · 通过 ' + cell.minutes + ' 分钟' +
          (cell.attempts ? '（' + cell.attempts + ' 次失败，该题罚时 +' + (cell.minutes + cell.attempts * penPer) + '）' : '');
        if (state.mode === '3h') {
          title += '\n时间轴压缩：原始 ' + VP.fmtClock(state.view.timeMap.toReal(cell.t)) + ' → 出现在 ' + VP.fmtClock(cell.t) +
            '\n该题罚时按压缩后时间算约 +' + (Math.floor(cell.t / 60000) + cell.attempts * penPer) + ' 分钟';
        }
        if (cell.manual) title += '\n（手动记录）';
      } else if (cell.state === 'WA') {
        cls = 'cell wa';
        text = '−' + cell.attempts;
        title = state.view.problems[p].label + ' 题 · 失败 ' + cell.attempts + ' 次（每题 +' + penPer + ' 分钟罚时）';
        if (state.mode === '3h') title += '\n3 小时模式下这些失败同样计入，罚时本身不缩放';
      } else if (cell.state === 'PD') {
        cls = 'cell pending';
        text = '…';
        title = state.view.problems[p].label + ' 题 · 判题中';
      } else if (cell.state === 'FZ') {
        cls = 'cell frozen';
        text = '?';
        title = state.view.problems[p].label + ' 题 · 封榜中' + (cell.attempts ? '（此前失败 ' + cell.attempts + ' 次）' : '');
        if (state.mode === '3h') title += '\n3 小时模式：封榜从 ' + VP.fmtClock(state.view.freezeStart) + ' 开始，还剩 ' +
          VP.fmtClock(Math.max(0, state.view.virtualDuration - state.elapsed)) + ' 揭榜';
      }

      var key = cls + '|' + text + '|' + title;
      if (c.last !== key) {
        c.last = key;
        c.cell.className = cls;
        c.cell.innerHTML = text;
        c.td.title = title;
      }
    }
  }

  function renderBoard(force) {
    if (!state.view) return;
    /* 同一秒内榜单不会变化（新提交按秒出现、格子显示分钟、罚时按分钟取整），
       重复调用直接跳过；播放时从每 90ms 重算降到每秒 1 次。 */
    var key = [
      Math.floor(state.elapsed / 1000),
      state.frozen ? 1 : 0,
      state.finished ? 1 : 0,
      state.search.trim().toLowerCase(),
      state.officialOnly ? 1 : 0,
      state.showMedals ? 1 : 0,
      state.selected || ''
    ].join('|');
    if (!force && key === state.standingsKey) { state.lastRender = performance.now(); return; }
    state.standingsKey = key;
    var t0 = performance.now();
    state.lastRender = t0;

    var stand = VP.computeStandings(state.view, state.elapsed, state.frozen, { onlyOfficial: state.officialOnly });
    state.standings = stand;

    var q = state.search.trim().toLowerCase();
    var rows = q ? stand.rows.filter(function (r) { return matchTeam(r.team, q); }) : stand.rows;

    var firstMap = new Map();
    for (var i = 0; i < stand.rows.length; i++) {
      var cells = stand.rows[i].cells;
      for (var p = 0; p < cells.length; p++) {
        var c = cells[p];
        if (c.state === 'AC') {
          var cur = firstMap.get(p);
          if (cur == null || c.t < cur) firstMap.set(p, c.t);
        }
      }
    }

    var tbody = els.tbody;
    var P = state.view.problems.length;
    var kept = new Set();
    var prev = null;

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var rec = state.rowCache.get(row.team.id);
      if (!rec) {
        rec = createRow(row, P);
        state.rowCache.set(row.team.id, rec);
      }
      kept.add(row.team.id);
      var sig = rowSignature(row, P);
      if (force || rec.sig !== sig) {
        updateRow(rec, row, firstMap);
        rec.sig = sig;
      }
      var expected = prev ? prev.nextSibling : tbody.firstChild;
      if (expected !== rec.tr) tbody.insertBefore(rec.tr, expected);
      prev = rec.tr;
    }

    state.rowCache.forEach(function (rec, id) {
      if (!kept.has(id)) {
        rec.tr.remove();
        state.rowCache.delete(id);
      }
    });

    if (!rows.length) {
      if (!state.emptyTr) {
        var empty = el('tr');
        var td = el('td');
        td.colSpan = 4 + P;
        td.style.textAlign = 'center';
        td.style.color = 'var(--text-mute)';
        td.style.padding = '26px 0';
        td.textContent = '没有匹配的队伍';
        empty.appendChild(td);
        state.emptyTr = empty;
      }
      tbody.appendChild(state.emptyTr);
      state.rowCache.forEach(function (rec) { rec.tr.remove(); });
      state.rowCache.clear();
    } else if (state.emptyTr && state.emptyTr.parentNode) {
      state.emptyTr.remove();
    }

    if (state.selected) {
      // 详情面板里名次可能变化，保持同步
      if (!els.drawer.hidden && els.drawer.classList.contains('open') && state.drawerKind === 'team') {
        updateDrawerStats();
      }
    }

    /* 轻量性能计数：最近一次完整重算耗时与行数，供调试面板/自动化读取 */
    state.perf = {
      ms: Math.round((performance.now() - t0) * 10) / 10,
      rows: rows.length,
      count: (state.perf && state.perf.count || 0) + 1,
      at: Date.now()
    };
  }

  /* ---------------- 队伍详情抽屉 ---------------- */
  function openDrawer(kind, title) {
    state.drawerKind = kind;
    els.drawerTitle.textContent = title;
    els.drawer.hidden = false;
    requestAnimationFrame(function () { els.drawer.classList.add('open'); });
  }

  function closeDrawer() {
    els.drawer.classList.remove('open');
    setTimeout(function () { if (!els.drawer.classList.contains('open')) els.drawer.hidden = true; }, 220);
    state.selected = null;
    renderBoard(true);
  }

  function teamRuns(teamId) {
    var cut = state.frozen ? Math.min(state.elapsed, state.view.freezeStart) : state.elapsed;
    return state.view.runs.filter(function (r) { return r.teamId === teamId && r.t <= cut; });
  }

  function fmtMinSec(ms) {
    ms = Math.max(0, Math.floor(ms));
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function openTeam(teamId) {
    var stand = state.standings;
    var row = stand && stand.rows.find(function (r) { return r.team.id === teamId; });
    if (!row) {
      var full = VP.computeStandings(state.view, state.elapsed, state.frozen, { onlyOfficial: false });
      row = full.rows.find(function (r) { return r.team.id === teamId; });
    }
    if (!row) return;
    state.selected = teamId;
    state.drawerRow = row;
    openDrawer('team', '队伍详情');
    renderTeamDrawer(row);
    renderBoard(true);
  }

  function renderTeamDrawer(row) {
    var team = row.team;
    var c = state.view.contest;
    var html = '';
    html += '<h2 class="dt-name">' + esc(team.name) + '</h2>';
    html += '<div class="dt-org">' + esc(team.org || '—') +
      (team.location ? ' · ' + esc(team.location) : '') + '</div>';

    var tags = [];
    if (team.unofficial) tags.push('<span class="tag star">' + esc(c.unofficialLabel) + '</span>');
    if (team.girl) tags.push('<span class="tag girl">女队</span>');
    if (tags.length) html += '<div style="margin-bottom:14px">' + tags.join(' ') + '</div>';

    html += '<div class="dt-stats">' +
      '<div class="dt-stat"><span>名次</span><b>' + row.rank + '</b></div>' +
      '<div class="dt-stat"><span>过题</span><b>' + row.solved + '</b></div>' +
      '<div class="dt-stat"><span>罚时</span><b>' + row.penalty + '</b></div>' +
      '</div>';

    if (row.medal) {
      var mname = { gold: '金牌区', silver: '银牌区', bronze: '铜牌区' }[row.medal];
      html += '<div style="font-size:12px;color:var(--text-mute);margin-bottom:10px">当前位于 <b style="color:var(--' + row.medal + ')">' + mname + '</b></div>';
    }

    html += '<div class="dt-section"><h4>题目</h4><div class="prob-list">';
    for (var p = 0; p < state.view.problems.length; p++) {
      var cell = row.cells[p];
      var prob = state.view.problems[p];
      var vtext = '', vcls = '';
      if (cell.state === 'AC') { vtext = cell.minutes + ' 分' + (cell.attempts ? ' (+' + cell.attempts + ')' : ''); vcls = 'color:var(--green)'; }
      else if (cell.state === 'WA') { vtext = '−' + cell.attempts; vcls = 'color:var(--red)'; }
      else if (cell.state === 'FZ') { vtext = '封榜'; vcls = 'color:var(--amber)'; }
      else if (cell.state === 'PD') { vtext = '判题中'; vcls = 'color:#8fc4f5'; }
      else { vtext = '—'; vcls = 'opacity:.4'; }
      html += '<div class="prob-row"><span class="pl">' + esc(prob.label) + '</span>' +
        '<span class="pv" style="' + vcls + '">' + vtext + '</span>' +
        '<span class="pt">' + (cell.state === 'AC' && state.mode === '3h' ? VP.fmtClock(cell.t) : '') + '</span></div>';
    }
    html += '</div></div>';

    var members = team.members || [];
    if (members.length) {
      html += '<div class="dt-section"><h4>队员</h4>';
      members.forEach(function (m) {
        html += '<div class="member"><span>' + esc(m.name) + '</span><span>' + esc(m.role || '') + '</span></div>';
      });
      html += '</div>';
    }
    if (team.coaches && team.coaches.length) {
      html += '<div class="dt-section"><h4>教练</h4>';
      team.coaches.forEach(function (m) {
        html += '<div class="member"><span>' + esc(m.name) + '</span><span>' + esc(m.role || '') + '</span></div>';
      });
      html += '</div>';
    }

    var runs = teamRuns(team.id);
    html += '<div class="dt-section"><h4>提交记录 · ' + runs.length + '</h4>';
    if (!runs.length) html += '<div class="mt-empty">此刻还没有提交</div>';
    else {
      runs.slice().reverse().forEach(function (r) {
        var label = state.view.problems[r.p] ? state.view.problems[r.p].label : '?';
        var cls = r.st === 'AC' ? 'ac' : (r.st === 'PD' ? 'fz' : 'bad');
        var name = { AC: 'AC', WA: '失败', TLE: '超时', RE: '运行错误', CE: '编译错误', MLE: '内存超限', PE: '格式错误', OLE: '输出超限', FAILED: '评测失败' }[r.st] || r.st;
        html += '<div class="tl-item"><span class="tt">' + VP.fmtClock(r.t) + '</span>' +
          '<span class="tp">' + esc(label) + '</span>' +
          '<span class="tv ' + cls + '">' + esc(name) + (r.manual ? ' · 手动' : '') + '</span></div>';
      });
    }
    html += '</div>';

    els.drawerBody.innerHTML = html;
  }

  function updateDrawerStats() {
    if (!state.drawerRow || state.drawerKind !== 'team') return;
    var stand = state.standings;
    var row = stand && stand.rows.find(function (r) { return r.team.id === state.drawerRow.team.id; });
    if (!row) return;
    state.drawerRow = row;
    renderTeamDrawer(row);
  }

  /* ---------------- 我的队伍 ---------------- */

  function openMyTeam() {
    if (!state.dataset) { toast('先加载一场比赛', 'err'); return; }
    openDrawer('my', '我的队伍');
    renderMyTeamDrawer();
    refreshQojStatus();
  }

  function renderMyTeamDrawer() {
    var html = '';
    var stand = state.standings;
    var row = null;
    if (state.myTeam && stand) row = stand.rows.find(function (r) { return r.team.id === state.myTeam.id; });

    if (!state.myTeam) {
      html += '<div class="mt-head"><div class="mt-title">还没有设置我的队伍</div>' +
        '<div class="mt-sub">你将以「我 · 本机」出现在榜单里。</div></div>';
      html += '<div class="mt-actions"><button class="btn primary" id="myCreate">创建我的队伍</button>' +
        '<button class="btn ghost" id="myJoin">从已有队伍中选择</button></div>';
      els.drawerBody.innerHTML = html;
      $('#myCreate').addEventListener('click', function () {
        state.myTeam = {
          id: VP.ME_ID, name: '我', org: '本机',
          official: true, unofficial: false, girl: false, members: [], coaches: [], location: '', custom: true
        };
        state.myTeamId = state.myTeam.id;
        rebuildView();
        saveMy();
        renderBoard(true);
        renderMyTeamDrawer();
        updateStatus();
        toast('已创建我的队伍：我 · 本机', 'ok');
      });
      $('#myJoin').addEventListener('click', function () { joinExisting(); });
      return;
    }

    var team = state.myTeam;
    html += '<div class="mt-head"><div class="mt-title">' + esc(team.name) +
      '<span class="tag me">我的队伍</span></div>' +
      '<div class="mt-sub">' + esc(team.org || (team.custom ? '自建队伍' : '来自榜单')) + '</div></div>';

    html += '<div class="dt-stats">' +
      '<div class="dt-stat"><span>名次</span><b>' + (row ? row.rank : '—') + '</b></div>' +
      '<div class="dt-stat"><span>过题</span><b>' + (row ? row.solved : 0) + '</b></div>' +
      '<div class="dt-stat"><span>罚时</span><b>' + (row ? row.penalty : 0) + '</b></div>' +
      '</div>';

    html += '<div class="mt-actions">' +
      '<button class="btn primary" id="myRecord">记录提交</button>' +
      '<button class="btn ghost" id="myQoj">提交到 QOJ</button>' +
      '<button class="btn ghost" id="myChange">更换队伍</button>' +
      '</div>';

    html += '<div class="dt-section"><h4>我的提交 · ' + state.myRuns.length + '</h4>';
    if (!state.myRuns.length) {
      html += '<div class="mt-empty">还没有记录。</div>';
    } else {
      html += '<div class="mt-list">';
      state.myRuns.slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (r, i) {
        var label = state.view.problems[r.p] ? state.view.problems[r.p].label : '?';
        var cls = r.st === 'AC' ? 'ac' : r.st === 'CE' ? 'ce' : 'bad';
        var txt = r.st === 'AC' ? 'AC' : r.st === 'CE' ? 'CE 不计罚时' : (r.raw && r.raw !== 'WA' ? r.raw : '失败');
        html += '<div class="mt-item"><span class="mi-t">' + VP.fmtClock(r.t) + '</span>' +
          '<span class="mi-p">' + esc(label) + '</span>' +
          '<span class="mi-s ' + cls + '">' + esc(txt) + '</span>' +
          '<button class="icon-btn" data-delrun="' + i + '" title="删除">✕</button></div>';
      });
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="dt-section"><h4>QOJ</h4><div style="font-size:12px;color:var(--text-mute)">' +
      (state.qoj.available
        ? (state.qoj.loggedIn
          ? '<span class="qoj-dot on"></span>已登录 ' + esc(state.qoj.user || '')
          : (state.qoj.hasSession
            ? '<span class="qoj-dot on"></span>已保存登录（用时自动恢复）'
            : '<span class="qoj-dot off"></span>未登录'))
        : '<span class="qoj-dot"></span>未连接本地服务') +
      '　<button class="btn tiny ghost" id="myQojSettings">设置</button></div></div>';

    els.drawerBody.innerHTML = html;

    $('#myRecord').addEventListener('click', openRecordModal);
    $('#myQoj').addEventListener('click', function () { openQojModal(); });
    $('#myQojSettings').addEventListener('click', function () { openQojModal('account'); });
    $('#myChange').addEventListener('click', function () {
      if (!confirm('更换队伍后，已记录的提交仍会保留，但会挂到新的队伍上。继续？')) return;
      state.myTeam = null;
      state.myTeamId = null;
      rebuildView();
      saveMy();
      renderMyTeamDrawer();
      renderBoard(true);
      updateStatus();
    });

    $$('[data-delrun]', els.drawerBody).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.dataset.delrun);
        var sorted = state.myRuns.slice().sort(function (a, b) { return a.t - b.t; });
        var target = sorted[idx];
        state.myRuns = state.myRuns.filter(function (r) { return r !== target; });
        rebuildView();
        saveMy();
        renderMyTeamDrawer();
        renderBoard(true);
      });
    });
  }

  function joinExisting() {
    // 用简单的搜索选择器
    var wrap = el('div');
    wrap.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
      '<button class="ghost icon" id="joinBack" title="返回">←</button>' +
      '<div style="font-size:13px;color:var(--text-dim)">搜索并选择你所在的队伍。</div></div>' +
      '<input id="joinSearch" type="text" placeholder="队伍名 / 学校" style="width:100%;height:36px;padding:0 10px;background:#0a1219;border:1px solid var(--border);border-radius:8px;outline:none;margin-bottom:10px">' +
      '<div id="joinList" style="max-height:320px;overflow:auto"></div>';
    els.drawerBody.innerHTML = '';
    els.drawerBody.appendChild(wrap);
    var input = $('#joinSearch', wrap);
    var list = $('#joinList', wrap);
    $('#joinBack', wrap).addEventListener('click', function () { renderMyTeamDrawer(); });
    input.focus();

    function refresh() {
      var q = input.value.trim().toLowerCase();
      var teams = state.dataset.teams.filter(function (t) { return !q || matchTeam(t, q); }).slice(0, 60);
      list.innerHTML = teams.map(function (t) {
        return '<div class="mt-item" style="cursor:pointer" data-pick="' + esc(t.id) + '">' +
          '<span class="mi-t">' + esc(t.id) + '</span>' +
          '<span class="mi-p"></span>' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.name) + '</span>' +
          '<span style="color:var(--text-mute);font-size:11px">' + esc(t.org || '') + '</span></div>';
      }).join('') || '<div class="mt-empty">没有匹配的队伍</div>';
      $$('[data-pick]', list).forEach(function (node) {
        node.addEventListener('click', function () {
          var team = state.dataset.teams.find(function (t) { return t.id === node.dataset.pick; });
          if (!team) return;
          state.myTeam = team;
          state.myTeamId = team.id;
          rebuildView();
          saveMy();
          renderMyTeamDrawer();
          renderBoard(true);
          updateStatus();
          toast('已选择队伍：' + team.name, 'ok');
        });
      });
    }
    input.addEventListener('input', refresh);
    refresh();
  }

  /* ---------------- 记录提交 ---------------- */
  var recordState = { p: null, verdict: 'AC' };

  function openRecordModal() {
    if (!state.myTeam) { toast('先设置我的队伍', 'err'); return; }
    recordState.p = null;
    recordState.verdict = 'AC';
    var grid = $('#recordProblems');
    grid.innerHTML = '';
    var stand = state.standings;
    var row = stand && stand.rows.find(function (r) { return r.team.id === state.myTeam.id; });
    state.view.problems.forEach(function (p, i) {
      var b = el('button');
      b.textContent = p.label;
      b.dataset.p = i;
      if (row && row.cells[i] && row.cells[i].state === 'AC') b.classList.add('solved');
      b.addEventListener('click', function () {
        recordState.p = i;
        $$('#recordProblems button').forEach(function (x) { x.classList.toggle('on', x === b); });
      });
      grid.appendChild(b);
    });
    $('#recordTime').value = fmtMinSec(state.elapsed);
    $$('#recordVerdicts button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.v === 'AC');
      b.onclick = function () {
        recordState.verdict = b.dataset.v;
        $$('#recordVerdicts button').forEach(function (x) { x.classList.toggle('on', x === b); });
      };
    });
    openModal('#recordOverlay');
  }

  function saveRecord() {
    if (recordState.p == null) { toast('选一道题', 'err'); return; }
    var t = VP.parseTimeToMs($('#recordTime').value);
    if (t == null) { toast('时间格式：mm:ss 或 h:mm:ss', 'err'); return; }
    t = clamp(t, 0, state.view.virtualDuration);
    state.myRuns.push({
      teamId: state.myTeamId, p: recordState.p, t: t, realTs: t,
      st: recordState.verdict, raw: recordState.verdict, manual: true, note: ''
    });
    rebuildView();
    saveMy();
    renderBoard(true);
    closeModal($('#recordOverlay'));
    if (state.drawerKind === 'my') renderMyTeamDrawer();
    var label = state.view.problems[recordState.p].label;
    toast('已记录 ' + label + ' ' + (recordState.verdict === 'AC' ? '通过' : recordState.verdict === 'CE' ? '编译错误（不计罚时）' : '失败') + ' @ ' + VP.fmtClock(t), 'ok');
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal(sel) { var m = $(sel); if (m) m.hidden = false; }
  function closeModal(m) { if (m) m.hidden = true; }

  /* ---------------- 时间曲线（帮助弹窗里的小图） ---------------- */
  var tcState = null;

  function fmtShort(ms) { return VP.fmtClock(ms).slice(0, 5); }

  function renderTimeCurve(hoverMs) {
    var svg = $('#tcSvg');
    if (!svg) return;
    var W = 560, H = 190, padL = 46, padR = 16, padT = 14, padB = 30;
    var iw = W - padL - padR, ih = H - padT - padB;
    var view = state.view;
    var map = view ? view.timeMap : VP.buildTimeMap({ durationMs: 5 * 3600e3, frozenMs: 3600e3 }, '3h');
    var D = map.durationMs || 1, V = map.virtualDuration || 1;
    var X = function (r) { return padL + (r / D) * iw; };
    var Y = function (t) { return padT + ih - (t / V) * ih; };
    var out = [];

    for (var h = 0; h * 3600e3 <= D; h++) {
      var rx = h * 3600e3;
      out.push('<line class="tc-grid" x1="' + X(rx).toFixed(1) + '" y1="' + padT + '" x2="' + X(rx).toFixed(1) + '" y2="' + (padT + ih) + '"/>');
      out.push('<text class="tc-tick" x="' + X(rx).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' + h + 'h</text>');
    }
    for (var q = 0; q * 3600e3 <= V; q++) {
      var ty = q * 3600e3;
      out.push('<line class="tc-grid" x1="' + padL + '" y1="' + Y(ty).toFixed(1) + '" x2="' + (padL + iw) + '" y2="' + Y(ty).toFixed(1) + '"/>');
      out.push('<text class="tc-tick" x="' + (padL - 8) + '" y="' + (Y(ty) + 4).toFixed(1) + '" text-anchor="end">' + q + 'h</text>');
    }

    out.push('<line class="tc-linear" x1="' + X(0) + '" y1="' + Y(0) + '" x2="' + X(D) + '" y2="' + Y(V) + '"/>');

    if (map.frozenMs > 0) {
      out.push('<line class="tc-freeze" x1="' + padL + '" y1="' + Y(map.freezeStart).toFixed(1) + '" x2="' + (padL + iw) + '" y2="' + Y(map.freezeStart).toFixed(1) + '"/>');
      out.push('<text class="tc-tick" x="' + (padL + iw - 2) + '" y="' + (Y(map.freezeStart) - 6).toFixed(1) + '" text-anchor="end">封榜 ' + fmtShort(map.freezeStart) + '</text>');
    }

    var pts = [];
    for (var i = 0; i <= 160; i++) {
      var r = D * i / 160;
      pts.push(X(r).toFixed(1) + ',' + Y(map.toVirtual(r)).toFixed(1));
    }
    out.push('<polyline class="tc-curve" points="' + pts.join(' ') + '"/>');

    var tipR = null;
    if (hoverMs != null) {
      tipR = Math.max(0, Math.min(D, hoverMs));
      out.push('<line class="tc-hover" x1="' + X(tipR).toFixed(1) + '" y1="' + padT + '" x2="' + X(tipR).toFixed(1) + '" y2="' + (padT + ih) + '"/>');
      out.push('<circle class="tc-dot" cx="' + X(tipR).toFixed(1) + '" cy="' + Y(map.toVirtual(tipR)).toFixed(1) + '" r="3.5"/>');
    }
    out.push('<rect class="tc-hit" x="' + padL + '" y="' + padT + '" width="' + iw + '" height="' + ih + '"/>');
    svg.innerHTML = out.join('');

    var tip = $('#tcTip');
    if (tip) {
      tip.textContent = tipR == null
        ? '横轴是原比赛时间，纵轴是这里显示的时间；灰色虚线是旧的等比例压缩，作对照。把鼠标移到图上可以看具体时刻。'
        : '原始 ' + VP.fmtClock(tipR) + ' → 显示 ' + VP.fmtClock(map.toVirtual(tipR)) +
          (map.curved ? '' : '（当前模式不做压缩）');
    }

    tcState = { map: map, padL: padL, padT: padT, iw: iw, ih: ih, W: W };
    if (!svg.dataset.bound) {
      svg.dataset.bound = '1';
      svg.addEventListener('mousemove', function (e) {
        if (!tcState) return;
        var rect = svg.getBoundingClientRect();
        if (!rect.width) return;
        var mx = (e.clientX - rect.left) / rect.width * W;
        var frac = (mx - padL) / iw;
        renderTimeCurve(Math.max(0, Math.min(1, frac)) * tcState.map.durationMs);
      });
      svg.addEventListener('mouseleave', function () { renderTimeCurve(null); });
    }
  }

  function bindModalDismiss() {
    $$('.overlay').forEach(function (ov) {
      ov.addEventListener('mousedown', function (e) {
        if (e.target === ov) closeModal(ov);
      });
    });
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-close]');
      if (btn) {
        var ov = btn.closest('.overlay');
        if (ov) closeModal(ov);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        $$('.overlay').forEach(function (ov) { if (!ov.hidden) closeModal(ov); });
        if (els.drawer.classList.contains('open')) closeDrawer();
      }
    });
  }

  /* ---------------- 数据源弹窗 ---------------- */
  function openDataModal() {
    els.dataUrl.value = state.contestInput || state.source || (loadPrefs().contestPath || '');
    var dq = $('#dataQoj');
    if (dq) {
      dq.value = state.dataset ? (qojContest().url || '') : '';
      dq.dataset.prefill = dq.value;
      dq.dataset.forKey = state.dataset ? qojContestKey() : '';
    }
    renderRecent();
    setLoadStatus('');
    openModal('#dataOverlay');
  }

  function renderRecent() {
    var list = Data.getRecent();
    var box = $('#recentList');
    if (!list.length) { box.innerHTML = '<span class="recent-empty">还没有加载记录</span>'; return; }
    box.innerHTML = list.map(function (r) {
      return '<button class="chip" data-path="' + esc(r.path) + '">' + esc(r.name || r.path) + '</button>';
    }).join('');
    $$('[data-path]', box).forEach(function (b) {
      b.addEventListener('click', function () {
        els.dataUrl.value = b.dataset.path;
        doLoadOnline();
      });
    });
  }

  function setLoadStatus(text, kind) {
    var s = $('#loadStatus');
    s.className = 'load-status' + (kind === 'error' ? ' error' : '');
    if (kind === 'loading') s.innerHTML = '<span class="spin"></span>' + esc(text);
    else s.textContent = text;
  }

  async function doLoadOnline() {
    var input = els.dataUrl.value.trim();
    if (!input) { setLoadStatus('请填写榜单链接或路径', 'error'); return; }
    var dqEl = $('#dataQoj');
    var qojUrl = dqEl ? dqEl.value.trim() : '';
    var btn = $('#btnLoadOnline');
    btn.disabled = true;
    setLoadStatus('加载中 …', 'loading');
    try {
      var isLocal = /^(\.\/|fixtures\/|local:|https?:\/\/127\.0\.0\.1)/.test(input);
      var payload = isLocal
        ? await Data.loadDemo(input.replace(/^local:/, ''), function (msg) { setLoadStatus(msg, 'loading'); })
        : await Data.loadOnline(input, function (msg) { setLoadStatus(msg, 'loading'); });
      applyPayload(payload);
      closeModal($('#dataOverlay'));
      // 换了另一场比赛时，输入框里残留的上一场链接不能顺带给新比赛
      if (qojUrl && dqEl && dqEl.dataset.prefill === qojUrl &&
          dqEl.dataset.forKey && dqEl.dataset.forKey !== qojContestKey()) {
        qojUrl = '';
      }
      await applyQojForContest(qojUrl);
    } catch (e) {
      setLoadStatus(e.message || String(e), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function applyQojForContest(input) {
    if (!state.dataset) return;
    var raw = String(input || '').trim();
    if (raw) {
      var url = qojUrlOf(raw);
      if (!url) { toast('没看懂 QOJ 比赛链接，示例：https://qoj.ac/contest/1234', 'err'); return; }
      if (!state.qoj.available) {
        var c0 = qojContest();
        c0.url = url;
        saveQoj();
        renderQojContest();
        return;
      }
      await adoptQojContest(url);
      return;
    }
    var c = qojContest();
    if (c.url && !Object.keys(c.mapping || {}).length && state.qoj.available) {
      await loadQojProblems(c.url);
    } else {
      renderQojContest();
    }
  }

  async function doLoadFiles(files) {
    var list = Array.from(files || []);
    if (!list.length) return;
    var box = $('#fileList');
    box.innerHTML = list.map(function (f) {
      return '<div class="file-item"><span class="fi-kind">JSON</span><span class="fi-name">' + esc(f.name) + '</span>' +
        '<span style="color:var(--text-mute)">' + Math.round(f.size / 1024) + ' KB</span></div>';
    }).join('');
    setLoadStatus('读取文件 …', 'loading');
    try {
      var payload = await Data.loadFiles(list);
      applyPayload(payload);
      closeModal($('#dataOverlay'));
      await applyQojForContest('');
    } catch (e) {
      setLoadStatus(e.message || String(e), 'error');
    }
  }

  /* ---------------- 初始化 ---------------- */
  function cacheEls() {
    els.btnPlay = $('#btnPlay');
    els.clockMain = $('#clockMain');
    els.clockSub = $('#clockSub');
    els.timeline = $('#timeline');
    els.timelineFill = $('#timelineFill');
    els.timelineKnob = $('#timelineKnob');
    els.freezeZone = $('#freezeZone');
    els.freezeBadge = $('#freezeBadge');
    els.tickLabels = $('#tickLabels');
    els.board = $('#board');
    els.head = $('#boardHead');
    els.tbody = $('#boardBody');
    els.emptyState = $('#emptyState');
    els.contestName = $('#contestName');
    els.contestMeta = $('#contestMeta');
    els.legendMode = $('#legendMode');
    els.statusLeft = $('#statusLeft');
    els.statusRight = $('#statusRight');
    els.drawer = $('#drawer');
    els.drawerTitle = $('#drawerTitle');
    els.drawerBody = $('#drawerBody');
    els.dataUrl = $('#dataUrl');
    els.search = $('#search');
  }

  function bindEvents() {
    els.btnPlay.addEventListener('click', function () { setPlaying(!state.playing); });
    $('#btnEditorial').addEventListener('click', openEditorial);
    $$('#modeSeg button').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.mode); });
    });

    $('#btnData').addEventListener('click', openDataModal);
    $('#emptyLoad').addEventListener('click', openDataModal);
    $('#emptyFiles').addEventListener('click', function () { $('#fileInput').click(); });
    $('#btnHelp').addEventListener('click', function () { openModal('#helpOverlay'); renderTimeCurve(null); });
    $('#btnMyTeam').addEventListener('click', openMyTeam);
    $('#drawerClose').addEventListener('click', closeDrawer);

    $('#search').addEventListener('input', function () {
      state.search = this.value;
      renderBoard(true);
    });
    $('#officialOnly').addEventListener('change', function () {
      state.officialOnly = this.checked;
      renderBoard(true);
      savePrefs();
    });
    $('#showMedals').addEventListener('change', function () {
      state.showMedals = this.checked;
      renderBoard(true);
      savePrefs();
    });

    // 时间轴拖动
    var tl = els.timeline;
    function fracFromEvent(e) {
      var rect = tl.getBoundingClientRect();
      return clamp((e.clientX - rect.left) / rect.width, 0, 1);
    }
    tl.addEventListener('pointerdown', function (e) {
      if (!state.view) return;
      state.dragging = true;
      tl.setPointerCapture(e.pointerId);
      seekFrac(fracFromEvent(e));
    });
    tl.addEventListener('pointermove', function (e) {
      if (!state.dragging) return;
      seekFrac(fracFromEvent(e));
    });
    tl.addEventListener('pointerup', function () { state.dragging = false; });
    tl.addEventListener('pointercancel', function () { state.dragging = false; });

    // 榜单点击
    els.tbody.addEventListener('click', function (e) {
      var tr = e.target.closest('tr');
      if (!tr || !tr.dataset.id) return;
      openTeam(tr.dataset.id);
    });

    // 数据源弹窗
    $('#btnLoadOnline').addEventListener('click', doLoadOnline);
    $('#btnDataQojDetect') && $('#btnDataQojDetect').addEventListener('click', searchQojForContest);
    bindQojPicker();
    bindBoardPicker();
    els.dataUrl.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLoadOnline(); });
    $('#fileInput').addEventListener('change', function (e) { doLoadFiles(e.target.files); });
    $('#dropzone').addEventListener('click', function () { $('#fileInput').click(); });
    $('#dropzone').addEventListener('dragover', function (e) { e.preventDefault(); this.classList.add('dragover'); });
    $('#dropzone').addEventListener('dragleave', function () { this.classList.remove('dragover'); });
    $('#dropzone').addEventListener('drop', function (e) {
      e.preventDefault();
      this.classList.remove('dragover');
      doLoadFiles(e.dataTransfer.files);
    });
    $$('#dataTabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#dataTabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        $$('.tab-panel', $('.modal-data')).forEach(function (p) {
          p.hidden = p.dataset.panel !== b.dataset.tab;
        });
        $('#btnLoadOnline').style.display = b.dataset.tab === 'online' ? '' : 'none';
      });
    });

    // 记录提交
    $('#btnRecordSave').addEventListener('click', saveRecord);
    $('#recordNow').addEventListener('click', function () {
      $('#recordTime').value = fmtMinSec(state.elapsed);
    });

    // QOJ
    bindQoj();

    // 全局拖拽
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      if (e.target.closest('#dropzone')) return;
      e.preventDefault();
      openModal('#dataOverlay');
      doLoadFiles(e.dataTransfer.files);
    });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ($$('.overlay').some(function (o) { return !o.hidden; })) return;
      if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(state.elapsed - (e.shiftKey ? 300000 : 60000)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(state.elapsed + (e.shiftKey ? 300000 : 60000)); }
      else if (e.key === '/') { e.preventDefault(); els.search.focus(); }
    });

    // 尺寸变化时重绘表头吸附
    window.addEventListener('resize', function () { /* sticky 自动处理 */ });
  }

  function initTicks() {
    els.tickLabels.innerHTML = '<span>0:00</span><span></span><span></span>';
  }

  function updateTicks() {
    if (!state.view) return;
    var V = state.view.virtualDuration;
    var marks = [0, V / 2, V];
    els.tickLabels.innerHTML = marks.map(function (m) { return '<span>' + VP.fmtClock(m).slice(0, 5) + '</span>'; }).join('');
  }

  function init() {
    cacheEls();
    var prefs = loadPrefs();

    var qs = null;
    try { qs = new URLSearchParams(location.search); } catch (e) { qs = null; }
    var demoPath = qs && qs.get('demo');
    if (qs) {
      if (qs.get('mode') === '3h' || qs.get('mode') === 'full') state.mode = qs.get('mode');
      if (qs.has('official')) state.officialOnly = qs.get('official') !== '0';
      if (qs.get('host') === '1') document.body.classList.add('hosted');
    }

    state.myTeamId = null;
    $('#officialOnly').checked = state.officialOnly;
    $('#showMedals').checked = state.showMedals;
    $$('#modeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === state.mode); });

    bindModalDismiss();
    bindEvents();
    initTicks();
    updatePlayButton();
    updateClock();

    // 自动恢复上一次的“我的队伍”
    if (prefs.key) {
      var my = loadMy(prefs.key);
      if (my && my.team) {
        state.myTeam = my.team;
        state.myTeamId = my.team.id;
        state.myRuns = my.runs || [];
        state.key = prefs.key;
      }
    }

    // 检查本地启动器
    Data.checkServer().then(function (info) {
      state.qoj.available = !!info.available;
      var verEl = document.getElementById('appVersion');
      if (verEl) {
        verEl.textContent = '版本 ' + (info.version || '—') + (info.build ? ' · 本地服务 ' + info.build : '');
      }
      if (info.available && !state.qojStaleNotified) {
        var feats = info.features || [];
        if (feats.indexOf('editorial') < 0) {
          state.qojStaleNotified = true;
          $('#statusRight').textContent = '本地服务是旧版本 · 关掉窗口后重新打开';
          toast('本地服务还是旧版本：关掉应用窗口，先运行 stop.bat，再重新打开', 'err');
        } else {
          $('#statusRight').textContent = '';
        }
      } else if (!info.available) {
        $('#statusRight').textContent = '';
      }
      if (info.available) {
        setTimeout(reportWindowSize, 1500);
        // 有些情况下（窗口被遮挡/由外部 Win32 移动）resize 事件会被合并或延迟，定时兜底
        setInterval(reportWindowSize, 2500);
        refreshQojStatus();
        window.addEventListener('resize', function () {
          clearTimeout(reportWindowSize._t);
          reportWindowSize._t = setTimeout(reportWindowSize, 700);
        });
      }
    });

    if (prefs.contestPath) {
      els.dataUrl.value = prefs.contestPath;
    }

    loadQoj();

    if (demoPath) {
      Data.loadDemo(demoPath, function (s) { $('#statusLeft').textContent = s; })
        .then(function (payload) {
          applyPayload(payload);
          if (qs.has('t')) seekTo(Number(qs.get('t')) * 1000);
          if (qs.get('play') === '1') { state.playing = true; updatePlayButton(); }
          renderBoard(true);
          updateClock();
          document.documentElement.dataset.ready = '1';
          var myId = qs.get('my');
          if (myId) {
            var picked = state.dataset.teams.find(function (t) { return t.id === myId; });
            if (picked) {
              state.myTeam = picked;
              state.myTeamId = picked.id;
              rebuildView();
              renderBoard(true);
            }
          }
          var panel = qs.get('panel');
          if (panel === 'my') openMyTeam();
          else if (panel === 'data') openDataModal();
          else if (panel === 'help') openModal('#helpOverlay');
          else if (panel === 'qoj') openQojModal();
          else if (panel === 'record') openRecordModal();
          else if (panel === 'team' && qs.get('team')) openTeam(qs.get('team'));
        })
        .catch(function (e) {
          console.error('示例数据加载失败', e);
          $('#statusLeft').textContent = '示例数据加载失败：' + e.message;
        });
    }

    requestAnimationFrame(tick);

    // 空状态直接引导
    setTimeout(function () {
      if (!state.dataset) {
        var hint = $('#statusLeft');
        hint.textContent = prefs.contestPath ? '上次的比赛：' + prefs.contestPath + '（点「数据源」重新加载）' : '未加载数据 · 点「数据源」加载一场比赛';
      }
    }, 60);
  }

  document.addEventListener('DOMContentLoaded', init);

  /* ============================================================
     QOJ：关联比赛、题号映射、提交与轮询
     ============================================================ */
  var qojPollTimer = null;
  var QOJ_STORE = 'xcpciovp.qoj.v1';

  function qojLog(line) {
    var pre = $('#qojLog');
    if (!pre) return;
    var t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    pre.textContent += '[' + t + '] ' + line + '\n';
    pre.scrollTop = pre.scrollHeight;
  }

  function qojContestKey() {
    if (!state.dataset) return '';
    var c = state.dataset.contest || {};
    var name = c.name || state.dataset.source || '本场';
    var day = '';
    if (c.startMs) {
      try { day = ' · ' + new Date(c.startMs).toISOString().slice(0, 10); } catch (e) { /* ignore */ }
    }
    return name + day;
  }

  function qojContest() {
    var k = qojContestKey();
    if (!k) return { url: '', problems: [], mapping: {} };
    if (!state.qoj.byContest) state.qoj.byContest = {};
    if (!state.qoj.byContest[k]) state.qoj.byContest[k] = {};
    var c = state.qoj.byContest[k];
    if (!c.mapping) c.mapping = {};
    if (!c.problems) c.problems = [];
    return c;
  }

  function saveQoj() {
    try {
      localStorage.setItem(QOJ_STORE, JSON.stringify({ byContest: state.qoj.byContest || {} }));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 题解 ---------------- */

  var editorialShown = null;

  function qojServerStale() {
    if (!QOJ.available) return false;
    var f = (Data.serverInfo && Data.serverInfo.features) || [];
    return f.indexOf('editorial') < 0;
  }

  function ensureEditorial() {
    if (!state.dataset) return Promise.resolve(null);
    var c = qojContest();
    if (!c || !c.url) return Promise.resolve(null);
    if (c.editorial) return Promise.resolve(c.editorial);
    if (state.qoj.editorialPromise) return state.qoj.editorialPromise;
    if (!QOJ.available) { toast('需要本地服务才能查找题解', 'err'); return Promise.resolve(null); }
    if (qojServerStale()) {
      qojLog('本地服务是旧版本（health 里没有 editorial）');
      toast('本地服务还是旧版本：请关掉应用窗口，先运行 stop.bat，再重新打开', 'err');
      return Promise.resolve(null);
    }
    if (c.editorialErrAt && Date.now() - c.editorialErrAt < 60000) return Promise.resolve(null);
    state.qoj.editorialLoading = true;
    qojLog('找题解：' + c.url);
    state.qoj.editorialPromise = QOJ.editorial(c.url).then(function (r) {
      c.editorial = r.pick ? { url: r.pick.href, text: r.pick.text } : { none: true };
      qojLog(r.pick ? '题解：' + r.pick.text : '这场比赛没有题解附件');
      saveQoj();
    }).catch(function (e) {
      c.editorialErrAt = Date.now();
      qojLog('取题解失败：' + e.message);
      if (/unknown action|404/i.test(e.message)) {
        toast('本地服务还是旧版本：请关掉应用窗口，先运行 stop.bat，再重新打开', 'err');
      } else {
        toast('查找题解失败：' + e.message, 'err');
      }
    }).then(function () {
      state.qoj.editorialLoading = false;
      state.qoj.editorialPromise = null;
      updateEditorialBtn();
      return c.editorial || null;
    });
    return state.qoj.editorialPromise;
  }

  function updateEditorialBtn() {
    var btn = $('#btnEditorial');
    if (!btn) return;
    var c = state.dataset ? qojContest() : null;
    var none = !!(c && c.editorial && c.editorial.none);
    var linked = !!(state.finished && c && c.url && !none);
    if (linked && !c.editorial) ensureEditorial();
    var url = linked && c.editorial && c.editorial.url ? c.editorial.url : '';
    var sig = linked ? (url || (state.qoj.editorialLoading ? '@loading' : '@waiting')) : '';
    if (sig === editorialShown) return;
    editorialShown = sig;
    btn.hidden = !linked;
    if (!linked) { btn.removeAttribute('title'); return; }
    if (url) {
      btn.textContent = '查看题解';
      btn.title = '在默认浏览器打开：' + (c.editorial.text || '比赛题解');
      btn.removeAttribute('disabled');
    } else if (state.qoj.editorialLoading) {
      btn.textContent = '正在查找题解…';
      btn.title = '正在 QOJ 比赛页里查找题解附件';
      btn.setAttribute('disabled', 'disabled');
    } else {
      btn.textContent = '查看题解';
      btn.title = '还没找到题解；点一下重试';
      btn.removeAttribute('disabled');
    }
  }

  async function openEditorial(e) {
    if (e) e.preventDefault();
    var c = state.dataset ? qojContest() : null;
    if (!c || !c.url) { toast('这场比赛还没有关联 QOJ 比赛', 'err'); return; }
    if (!c.editorial || !c.editorial.url) {
      c.editorialErrAt = 0;
      await ensureEditorial();
    }
    if (!c.editorial || !c.editorial.url) {
      toast(c.editorial && c.editorial.none ? '这场比赛在 QOJ 上没有题解附件' : '还没有拿到题解链接', 'err');
      return;
    }
    if (!QOJ.available) { toast('需要本地服务才能打开浏览器', 'err'); return; }
    try {
      var res = await fetch('/api/open?url=' + encodeURIComponent(c.editorial.url));
      var j = null;
      try { j = await res.json(); } catch (err) { j = null; }
      if (!res.ok || (j && j.ok === false)) throw new Error((j && j.error) || ('HTTP ' + res.status));
      toast('已在默认浏览器打开题解', 'ok');
    } catch (err) {
      toast('打开失败：' + err.message, 'err');
    }
  }

  function loadQoj() {
    try {
      var q = JSON.parse(localStorage.getItem(QOJ_STORE) || '{}');
      state.qoj.byContest = q.byContest || {};
    } catch (e) { state.qoj.byContest = {}; }
  }

  function bindQoj() {
    $('#btnQojSubmit') && $('#btnQojSubmit').addEventListener('click', doQojSubmit);
    $('#qojTabs') && $$('#qojTabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#qojTabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        $$('.modal-qoj .tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab; });
      });
    });
    $('#btnQojContest') && $('#btnQojContest').addEventListener('click', function () { openDataModal(); });    $('#qojCode') && $('#qojCode').addEventListener('dragover', function (e) { e.preventDefault(); });
    $('#qojCode') && $('#qojCode').addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { $('#qojCode').value = String(fr.result); };
      fr.readAsText(f, 'utf-8');
    });
  }

  function openQojModal(tab) {
    if (!state.dataset) { toast('先加载一场比赛', 'err'); return; }
    openModal('#qojOverlay');
    if (tab) {
      $$('#qojTabs button').forEach(function (x) { x.classList.toggle('on', x.dataset.tab === tab); });
      $$('.modal-qoj .tab-panel').forEach(function (p) { p.hidden = p.dataset.panel !== tab; });
    }
    fillQojModal();
    refreshQojStatus().then(maybeAdoptFromWindow);
  }

  function fillQojModal() {
    if (!state.view) return;
    renderQojContest();
    renderQojLanguage();
    renderQojAccount();
    renderQojMapping();
    renderQojState();
  }

  function renderQojContest() {
    var c = qojContest();
    var st = $('#qojContestStatus');
    var total = state.view ? state.view.problems.length : 0;
    var mapped = Object.keys(c.mapping || {}).length;
    if (st) {
      if (!c.url) {
        st.textContent = '这场比赛还没有关联 QOJ 比赛：在「数据源」里填这一场的链接，或在 QOJ 窗口打开比赛页后点「设置比赛」';
        st.className = 'qoj-contest-status';
      } else {
        st.textContent = '已关联 ' + c.url.replace(/^https?:\/\//, '') + '，已映射 ' + mapped + '/' + total + ' 题';
        st.className = 'qoj-contest-status ok';
      }
    }
    fillQojProblems();
  }

  function fillQojProblems() {
    var sel = $('#qojProblem');
    if (!sel || !state.view) return;
    var c = qojContest();
    var prev = sel.value;
    sel.innerHTML = state.view.problems.map(function (p, i) {
      var id = c.mapping[i];
      return '<option value="' + i + '">' + esc(p.label + (p.title ? ' · ' + p.title : '')) +
        (id ? ' → QOJ #' + id : '（未映射）') + '</option>';
    }).join('');
    if (prev !== '' && prev != null) sel.value = prev;
  }

  function renderQojLanguage() {
    var lang = $('#qojLanguage');
    if (!lang) return;
    if (lang.options.length) return;
    var list = state.qoj.languages && state.qoj.languages.length ? state.qoj.languages : ['C++17', 'C++20', 'C', 'Python 3', 'Java', 'PyPy3'];
    lang.innerHTML = list.map(function (l) { return '<option>' + esc(l) + '</option>'; }).join('');
  }

  /* QOJ 账号记忆：用户名总记住；密码只在勾选「记住密码」时存（本机 localStorage，明文） */
  var QOJ_LOGIN_KEY = 'xcpciovp.qojlogin.v1';

  function loadQojLogin() {
    try {
      var j = JSON.parse(localStorage.getItem(QOJ_LOGIN_KEY) || '{}') || {};
      return { user: String(j.user || ''), pass: String(j.pass || ''), remember: !!j.remember };
    } catch (e) {
      return { user: '', pass: '', remember: false };
    }
  }

  function saveQojLogin(user, pass, remember) {
    try {
      var o = { user: String(user || ''), remember: !!remember };
      if (remember && pass) o.pass = String(pass);
      localStorage.setItem(QOJ_LOGIN_KEY, JSON.stringify(o));
    } catch (e) { }
  }

  function renderQojAccount() {
    var box = $('#qojAccount');
    if (!box) return;
    if (!state.qoj.available) {
      box.innerHTML = '<div style="font-size:12.5px;color:var(--amber);line-height:1.7">' +
        '没有连接本地服务，QOJ 相关功能不可用。</div>';
      return;
    }
    if (state.qoj.loggedIn) {
      box.innerHTML = '<div style="display:flex;align-items:center;gap:10px;font-size:13px">' +
        '<span class="qoj-dot on"></span>已登录 <b>' + esc(state.qoj.user || '') + '</b>' +
        '<button class="btn tiny ghost" id="qojLogout">退出</button></div>';
      $('#qojLogout').addEventListener('click', async function () {
        try { await QOJ.logout(); } catch (e) { /* ignore */ }
        state.qoj.loggedIn = false; state.qoj.user = '';
        renderQojAccount(); renderQojState();
      });
    } else {
      var cred = loadQojLogin();
      box.innerHTML = '<div class="mt-form">' +
        '<label class="field"><span>QOJ 用户名</span><input id="qojUser" type="text" autocomplete="username" value="' + esc(cred.user) + '"></label>' +
        '<label class="field"><span>密码</span><input id="qojPass" type="password" autocomplete="current-password" value="' + esc(cred.pass) + '"></label>' +
        '</div><div class="mt-actions">' +
        '<label class="mt-remember"><input id="qojRemember" type="checkbox"' + (cred.remember ? ' checked' : '') + '> 记住密码（本机保存）</label>' +
        '<button class="btn primary" id="qojLogin">登录 QOJ</button></div>';
      $('#qojRemember').addEventListener('change', function () {
        var u = $('#qojUser') ? $('#qojUser').value : '';
        var p = $('#qojPass') ? $('#qojPass').value : '';
        saveQojLogin(u, p, this.checked);
      });
      $('#qojLogin').addEventListener('click', async function () {
        var u = $('#qojUser').value.trim(), p = $('#qojPass').value;
        var remember = !!(($('#qojRemember') || {}).checked);
        if (!u || !p) { toast('填用户名和密码', 'err'); return; }
        saveQojLogin(u, remember ? p : '', remember);
        try {
          qojLog('登录 ' + u + ' …');
          var r = await QOJ.login(u, p);
          state.qoj.loggedIn = true;
          state.qoj.user = r.user || u;
          saveQojLogin(state.qoj.user, remember ? p : '', remember);
          qojLog('登录成功');
          renderQojAccount(); renderQojState();
          maybeAdoptFromWindow();
        } catch (e) {
          qojLog('登录失败：' + e.message);
          toast('QOJ 登录失败：' + e.message, 'err');
        }
        $('#qojPass').value = '';
      });
    }
  }

  function renderQojMapping() {
    if (!state.view) return;
    var box = $('#qojMapping');
    if (!box) return;
    var c = qojContest();
    box.innerHTML = state.view.problems.map(function (p, i) {
      return '<div class="map-row"><label>' + esc(p.label) + '</label>' +
        '<input data-map="' + i + '" type="text" placeholder="题号" value="' + esc(c.mapping[i] || '') + '"></div>';
    }).join('');
    $$('[data-map]', box).forEach(function (inp) {
      inp.addEventListener('change', function () {
        var i = Number(inp.dataset.map);
        var v = inp.value.trim().replace(/[^\d]/g, '');
        if (v) c.mapping[i] = v; else delete c.mapping[i];
        saveQoj();
        renderQojContest();
      });
    });
  }

  function renderQojState() {
    var s = $('#qojState');
    if (!s) return;
    s.className = 'qoj-state';
    if (!state.qoj.available) { s.textContent = '未连接本地服务'; s.classList.add('err'); return; }
    if (!state.qoj.loggedIn) { s.textContent = '未登录 QOJ'; return; }
    s.textContent = '已登录 ' + (state.qoj.user || '');
    s.classList.add('ok');
  }

  async function refreshQojStatus() {
    if (!state.qoj.available) return;
    try {
      var s = await QOJ.status();
      state.qoj.loggedIn = !!s.loggedIn;
      state.qoj.user = s.user || '';
      state.qoj.hasSession = !!s.hasSession;
      state.qoj.pageUrl = s.url || '';
      if (s.languages && s.languages.length) state.qoj.languages = s.languages;
      if (state.qoj.loggedIn && state.qoj.user) {
        var cur = loadQojLogin();
        if (cur.user !== state.qoj.user) saveQojLogin(state.qoj.user, cur.pass, cur.remember);
      }
      renderQojAccount();
      renderQojState();
      if (state.drawerKind === 'my') renderMyTeamDrawer();
    } catch (e) { /* ignore */ }
  }

  function contestUrlFromPage(url) {
    var m = /qoj\.ac\/contest\/(\d+)/.exec(String(url || ''));
    return m ? 'https://qoj.ac/contest/' + m[1] : '';
  }

  async function maybeAdoptFromWindow() {
    var c = qojContest();
    if (c.url || !state.qoj.loggedIn) return;
    var url = contestUrlFromPage(state.qoj.pageUrl);
    if (!url) return;
    qojLog('从 QOJ 窗口识别到比赛：' + url);
    await adoptQojContest(url);
  }

  function qojDateOf(ms) {
    var n = Number(ms) || 0;
    if (!(n > 0)) return '';
    var d = new Date(n);
    if (isNaN(d.getTime())) return '';
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /* 用榜单的「赛站标识」去 QOJ 搜索这场比赛：
     榜单路径最后一段通常是拼音或英文（icpc/50th/nanjing → nanjing），
     而 QOJ 的比赛名是英文（Grand Prix of Nanjing），拿这个词去搜命中率最高；
     路径不是这种形式时退回用比赛名里的英文词，再不行才按开赛日期圈。 */
  function qojQueryForContest() {
    var raw = String(state.contestInput || '').trim();
    if (!raw) {
      var input = $('#dataUrl');
      raw = input ? String(input.value || '').trim() : '';
    }
    var seg = '';
    if (raw && !/^[a-z]:\\/i.test(raw)) {
      var path = raw;
      if (/^https?:\/\//.test(raw)) {
        try { path = new URL(raw).pathname; } catch (e) { path = ''; }
      }
      var parts = path.replace(/[?#].*$/, '').split('/').filter(Boolean);
      var last = parts.length ? parts[parts.length - 1] : '';
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/.test(last) && !/\.json$/i.test(last)) seg = last.replace(/\.[a-z]+$/i, '');
    }
    if (seg) return seg;
    var name = (state.dataset && state.dataset.contest && state.dataset.contest.name) || '';
    var latin = (name.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) || []).join(' ');
    return latin;
  }

  async function searchQojForContest() {
    if (!state.qoj.available) { toast('需要本地服务，请从 VPBoardBetter.exe 打开', 'err'); return; }
    var q = qojQueryForContest();
    var startMs = state.dataset && state.dataset.contest && state.dataset.contest.startMs;
    var date = startMs ? qojDateOf(startMs) : '';
    var box = $('#qojPicker');
    if (box) box.hidden = false;
    var s = $('#qojPickerSearch');
    if (s) { s.value = q; s.focus(); }
    if (q) {
      qojPicker.date = '';
      loadQojPicker(q);
      return;
    }
    qojPicker.date = date || '';
    loadQojPicker('');
    if (!date) toast('在下面的搜索框里输入比赛名或编号，或者先选好榜单再点这里');
  }

  /* 从 QOJ 比赛列表里挑一场 */
  var qojPicker = { loading: false, timer: 0, lastQuery: '', items: [], date: '' };

  function bindQojPicker() {
    var btn = $('#btnDataQojPick');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var box = $('#qojPicker');
      if (!box) return;
      box.hidden = !box.hidden;
      if (!box.hidden) {
        var s = $('#qojPickerSearch');
        if (s) { s.focus(); s.select(); }
        qojPicker.date = '';
        loadQojPicker('');
      }
    });
    var close = $('#btnQojPickerClose');
    if (close) close.addEventListener('click', function () { $('#qojPicker').hidden = true; });
    var search = $('#qojPickerSearch');
    if (search) {
      search.addEventListener('input', function () {
        clearTimeout(qojPicker.timer);
        var q = search.value.trim();
        qojPicker.date = '';
        qojPicker.timer = setTimeout(function () { loadQojPicker(q); }, 260);
      });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { clearTimeout(qojPicker.timer); loadQojPicker(search.value.trim()); }
        if (e.key === 'Escape') { $('#qojPicker').hidden = true; }
      });
    }
  }

  function qojPickerTip(text, isErr) {
    var tip = $('#qojPickerTip');
    if (!tip) return;
    tip.textContent = text;
    tip.className = 'qoj-picker-tip' + (isErr ? ' err' : '');
  }

  async function loadQojPicker(q) {
    var list = $('#qojPickerList');
    if (!list) return;
    if (!state.qoj.available) {
      list.innerHTML = '';
      qojPickerTip('需要本地服务才能读取 QOJ 比赛列表', true);
      return;
    }
    var date = q ? '' : (qojPicker.date || '');
    var key = (q || '') + '|' + date;
    if (qojPicker.loading && key === qojPicker.lastQuery) return;
    qojPicker.loading = true;
    qojPicker.lastQuery = key;
    qojPickerTip(date ? '按开赛日期 ' + date + ' 查找 …' : (q ? '搜索中 …' : '读取 QOJ 比赛列表 …'));
    try {
      var r = await QOJ.contests(q, 40, date);
      if (key !== qojPicker.lastQuery) return;
      qojPicker.items = r.items || [];
      if (!qojPicker.items.length && q && state.dataset) {
        var d = qojDateOf(state.dataset.contest && state.dataset.contest.startMs);
        if (d) {
          qojPicker.date = d;
          qojPickerTip('按「' + q + '」没找到，改成按开赛日期 ' + d + ' 查找 …');
          qojPicker.loading = false;
          return loadQojPicker('');
        }
      }
      list.innerHTML = qojPicker.items.length
        ? qojPicker.items.map(function (c) {
          return '<button class="qoj-picker-item" data-url="https://qoj.ac/contest/' + esc(c.id) + '">' +
            '<span class="qpi-id">#' + esc(c.id) + '</span>' +
            '<span class="qpi-title">' + esc(c.title) + '</span>' +
            (c.start ? '<span class="qpi-start">' + esc(c.start) + '</span>' : '') +
            '</button>';
        }).join('')
        : '<div class="qoj-picker-tip">没有匹配的比赛，换个关键词试试</div>';
      $$('.qoj-picker-item', list).forEach(function (b) {
        b.addEventListener('click', function () {
          var dq = $('#dataQoj');
          if (dq) dq.value = b.dataset.url;
          $('#qojPicker').hidden = true;
          toast('已选 QOJ 比赛 ' + b.dataset.url.replace(/^https?:\/\/qoj\.ac\/contest\//, '#'), 'ok');
        });
      });
      qojPickerTip(date
        ? '开赛日期在 ' + date + ' 前后 2 天的比赛共 ' + (r.matched != null ? r.matched : qojPicker.items.length) + ' 场；也可以直接输入关键词按名字搜。'
        : (q
          ? '匹配 ' + (r.matched != null ? r.matched : qojPicker.items.length) + ' 场，显示前 ' + qojPicker.items.length + ' 场。'
          : '共 ' + (r.total || 0) + ' 场，显示最近 ' + qojPicker.items.length + ' 场；输入关键词可以缩小范围。'));
    } catch (e) {
      list.innerHTML = '';
      qojPickerTip('读取失败：' + e.message, true);
    } finally {
      qojPicker.loading = false;
    }
  }

  /* 从 XCPCIO 榜单列表里挑一场 */
  var boardPicker = { loading: false, timer: 0, lastQuery: '', items: [], total: 0 };

  function bindBoardPicker() {
    var btn = $('#btnDataBoardPick');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var box = $('#boardPicker');
      if (!box) return;
      box.hidden = !box.hidden;
      if (!box.hidden) {
        var s = $('#boardPickerSearch');
        if (s) { s.focus(); s.select(); }
        loadBoardPicker('');
      }
    });
    var close = $('#btnBoardPickerClose');
    if (close) close.addEventListener('click', function () { $('#boardPicker').hidden = true; });
    var search = $('#boardPickerSearch');
    if (search) {
      search.addEventListener('input', function () {
        clearTimeout(boardPicker.timer);
        var q = search.value.trim();
        boardPicker.timer = setTimeout(function () { loadBoardPicker(q); }, 260);
      });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { clearTimeout(boardPicker.timer); loadBoardPicker(search.value.trim()); }
        if (e.key === 'Escape') { $('#boardPicker').hidden = true; }
      });
    }
  }

  function boardPickerTip(text, isErr) {
    var tip = $('#boardPickerTip');
    if (!tip) return;
    tip.textContent = text;
    tip.className = 'qoj-picker-tip' + (isErr ? ' err' : '');
  }

  async function loadBoardPicker(q) {
    var list = $('#boardPickerList');
    if (!list) return;
    boardPicker.lastQuery = q;
    boardPickerTip(q ? '搜索中 …' : '读取榜单列表（第一次要几秒）…');
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 150000);
    try {
      var res = await fetch('/api/boards?q=' + encodeURIComponent(q) + '&limit=40', { signal: ac.signal });
      var r = await res.json();
      if (!r || !r.ok) throw new Error((r && r.error) || ('HTTP ' + res.status));
      if (q !== boardPicker.lastQuery) return;
      boardPicker.items = r.items || [];
      boardPicker.total = r.total || 0;
      list.innerHTML = boardPicker.items.length
        ? boardPicker.items.map(function (b) {
          return '<button class="qoj-picker-item" title="' + esc(b.n || b.p) + '" data-path="' + esc(b.p) + '" data-name="' + esc(b.n || '') + '" data-date="' + esc(b.t || '') + '">' +
            '<span class="qpi-id">' + esc(b.t || '----') + '</span>' +
            '<span class="qpi-title">' + esc(b.n || b.p) + '</span>' +
            '<span class="qpi-start">' + esc(b.p) + '</span>' +
            '</button>';
        }).join('')
        : '<div class="qoj-picker-tip">没有匹配的榜单，换个关键词试试</div>';
      $$('.qoj-picker-item', list).forEach(function (el) {
        el.addEventListener('click', function () { pickBoard(el.dataset.path, el.dataset.name, el.dataset.date); });
      });
      boardPickerTip(q
        ? '匹配 ' + (r.matched != null ? r.matched : boardPicker.items.length) + ' 场，显示前 ' + boardPicker.items.length + ' 场。'
        : '共 ' + r.total + ' 场，显示最近 ' + boardPicker.items.length + ' 场；输入关键词可以缩小范围。');
    } catch (e) {
      list.innerHTML = '';
      boardPickerTip(/abort/i.test(e.name || e.message || '')
        ? '读取超时，请稍后再试'
        : '读取失败：' + (e.message || e), true);
    } finally {
      clearTimeout(timer);
    }
  }

  function pickBoard(path, name, date) {
    if (!path) return;
    els.dataUrl.value = path;
    var dq = $('#dataQoj');
    if (dq) {
      var key = name ? name + (date ? ' · ' + date : '') : '';
      var saved = key && state.qoj.byContest ? state.qoj.byContest[key] : null;
      var url = saved && saved.url ? saved.url : '';
      if (url || dq.value === (dq.dataset.prefill || '')) {
        dq.value = url;
        dq.dataset.prefill = url;
        dq.dataset.forKey = key;
      }
      $('#boardPicker').hidden = true;
      if (url) toast('已选「' + name + '」，并带上它之前关联的 QOJ 比赛', 'ok');
      else toast('已选「' + (name || path) + '」', 'ok');
    } else {
      $('#boardPicker').hidden = true;
    }
  }

  function qojUrlOf(raw) {
    var url = String(raw || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//.test(url)) {
      var id = url.replace(/\D/g, '');
      if (!id) return '';
      url = 'https://qoj.ac/contest/' + id;
    }
    return url;
  }

  async function adoptQojContest(raw) {
    var url = qojUrlOf(raw);
    if (!url) { toast('先粘贴 QOJ 比赛链接（形如 https://qoj.ac/contest/1234）', 'err'); return; }
    var c = qojContest();
    c.url = url;
    saveQoj();
    renderQojContest();
    await loadQojProblems(url);
  }

  async function loadQojProblems(url) {
    if (!state.qoj.available) { toast('需要本地服务', 'err'); return; }
    try {
      qojLog('读取比赛题目：' + url);
      var r = await QOJ.problems(url);
      var list = (r && r.problems) || [];
      var c = qojContest();
      c.problems = list;
      c.mapping = {};
      var total = state.view ? state.view.problems.length : 0;
      var byLabel = {};
      if (state.view) state.view.problems.forEach(function (p, i) { byLabel[String(p.label).toUpperCase()] = i; });
      list.forEach(function (p, i) {
        var letter = p.letter ? String(p.letter).toUpperCase() : '';
        var idx = (letter && byLabel[letter] != null) ? byLabel[letter] : i;
        if (idx < total) c.mapping[idx] = String(p.id);
      });
      saveQoj();
      renderQojContest();
      renderQojMapping();
      qojLog('题目 ' + list.length + ' 道，已映射 ' + Math.min(list.length, total) + ' 题');
      if (!list.length) toast('这个链接里没找到题目', 'err');
    } catch (e) {
      qojLog('读取题目失败：' + e.message);
      toast('读取题目失败：' + e.message, 'err');
    }
  }

  async function doQojSubmit() {
    if (!state.qoj.available) { toast('需要本地服务，请从 VPBoardBetter.exe 打开', 'err'); return; }
    if (!state.qoj.loggedIn) { toast('先登录 QOJ（账号与映射页）', 'err'); return; }
    var c = qojContest();
    if (!c.url) { toast('先在「比赛」那一行关联这场比赛的 QOJ 链接', 'err'); return; }
    var pIdx = Number($('#qojProblem').value);
    var problemId = c.mapping[pIdx];
    if (!problemId) { toast('这道题还没有对应的 QOJ 题号', 'err'); return; }
    var code = $('#qojCode').value;
    if (!code.trim()) { toast('粘贴代码', 'err'); return; }
    if (!state.myTeam) { toast('先设置「我的队伍」，提交结果才能记进榜单', 'err'); return; }

    var lang = $('#qojLanguage').value;
    var submitElapsed = state.elapsed;
    var label = state.view.problems[pIdx].label;
    var btn = $('#btnQojSubmit');
    btn.disabled = true;
    $('#qojState').textContent = '提交中 …';
    $('#qojState').className = 'qoj-state';
    try {
      qojLog('提交 ' + label + ' → QOJ #' + problemId + ' / ' + lang + ' / ' + code.length + ' 字节');
      var r = await QOJ.submit({ problemId: problemId, language: lang, code: code });
      qojLog('提交成功 #' + r.submissionId + '，等待评测…');
      $('#qojState').textContent = '已提交 #' + r.submissionId + '，等待评测…';
      toast('已提交 QOJ #' + r.submissionId + '，等待评测…', 'ok');
      pollQojSubmission(r.submissionId, pIdx, submitElapsed, label);
    } catch (e) {
      qojLog('提交失败：' + e.message);
      toast('QOJ 提交失败：' + e.message, 'err');
      $('#qojState').textContent = '提交失败';
      $('#qojState').className = 'qoj-state err';
    } finally {
      btn.disabled = false;
    }
  }

  function pollQojSubmission(id, pIdx, submitElapsed, label) {
    clearTimeout(qojPollTimer);
    var tries = 0;
    var step = async function () {
      tries++;
      try {
        var s = await QOJ.submission(id);
        qojLog('轮询 #' + id + '：' + (s.verdict || s.status || '?'));
        if (s.final || s.finished) {
          var verdict = s.verdict || s.status || 'Unknown';
          var norm = VP.normalizeStatus(verdict);
          var st = norm.st === 'AC' ? 'AC' : norm.st === 'CE' ? 'CE' : 'WA';
          var ok = st === 'AC';
          state.myRuns.push({
            teamId: state.myTeamId, p: pIdx, t: submitElapsed, realTs: submitElapsed,
            st: st, raw: verdict, manual: true, note: 'QOJ #' + id
          });
          rebuildView(); saveMy(); renderBoard(true);
          if (state.drawerKind === 'my') renderMyTeamDrawer();
          var when = fmtMinSec(submitElapsed);
          toast('QOJ #' + id + ' ' + verdict + (st === 'CE' ? '（不计罚时）' : '') + '，已按 ' + when + ' 记入 ' + label + ' 题', ok ? 'ok' : 'err');
          $('#qojState').textContent = '评测完成：' + verdict + '（已记入 ' + when + '）';
          $('#qojState').className = 'qoj-state ' + (ok ? 'ok' : 'err');
          return;
        }
        $('#qojState').textContent = '评测中：' + (s.verdict || s.status || '…');
      } catch (e) {
        qojLog('轮询失败：' + e.message);
      }
      if (tries < 150) qojPollTimer = setTimeout(step, 2000);
    };
    step();
  }

window.VPApp = {
    state: state,
    openQojModal: openQojModal,
    applyPayload: applyPayload,
    loadQoj: loadQoj,
    renderTimeCurve: renderTimeCurve,
  };
})();
