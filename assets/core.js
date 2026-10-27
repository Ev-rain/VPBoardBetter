/* ============================================================
   core.js — 纯逻辑：数据归一化、时间轴缩放、榜单计算
   不依赖 DOM，可在 Node 中直接 require 做单元测试。
   ============================================================ */
(function (root, factory) {
  var VP = factory();
  root.VP = VP;
  if (typeof module === 'object' && module.exports) module.exports = VP;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var ME_ID = '__me__';
  var AC_STATES = ['AC', 'ACCEPTED', 'CORRECT', 'OK', 'YES', 'PASSED', 'ACCEPT'];
  var PENDING_STATES = ['PENDING', 'JUDGING', 'WAITING', 'QUEUE', 'QUEUING', 'RUNNING', 'COMPILING', 'SUBMITTED', 'PENDING_REJUDGE'];

  var collator = null;
  try {
    collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  } catch (e) { collator = { compare: function (a, b) { return a < b ? -1 : a > b ? 1 : 0; } }; }

  function compareName(a, b) { return collator.compare(a || '', b || ''); }

  function num(v, d) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }

  /* ---------------- 文本 / 人名 ---------------- */
  function normText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') return String(v);
    if (typeof v === 'object') {
      if (typeof v.text === 'string') return v.text.trim();
      if (typeof v.name === 'string') return v.name.trim();
      if (v.texts && typeof v.texts === 'object') {
        var keys = Object.keys(v.texts);
        if (v.fallback_lang && v.texts[v.fallback_lang]) return String(v.texts[v.fallback_lang]).trim();
        if (v.texts['zh-CN']) return String(v.texts['zh-CN']).trim();
        if (v.texts.zh) return String(v.texts.zh).trim();
        if (v.texts.en) return String(v.texts.en).trim();
        for (var i = 0; i < keys.length; i++) {
          var t = v.texts[keys[i]];
          if (t) return String(t).trim();
        }
      }
      if (v.name) return normText(v.name);
    }
    return '';
  }

  function normPeople(list) {
    if (!list) return [];
    if (!Array.isArray(list)) list = [list];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p == null) continue;
      if (typeof p === 'string') { if (p.trim()) out.push({ name: p.trim(), role: '' }); continue; }
      var name = normText(p.name || p.team_member || p.member || p);
      if (!name) continue;
      out.push({ name: name, role: normText(p.role || p.title || '') });
    }
    return out;
  }

  /* ---------------- 比赛配置 ---------------- */
  function normalizeContest(cfg) {
    cfg = cfg || {};
    var startMs = num(cfg.start_time || cfg.startTime || cfg.start, 0);
    if (startMs > 0 && startMs < 1e12) startMs *= 1000;
    var endMs = num(cfg.end_time || cfg.endTime || cfg.end, 0);
    if (endMs > 0 && endMs < 1e12) endMs *= 1000;

    var durationMs = 0;
    if (endMs > startMs) durationMs = endMs - startMs;
    if (!durationMs && cfg.duration) durationMs = num(cfg.duration) * 1000;
    if (!durationMs) durationMs = (endMs > 0 ? endMs : 0) - startMs;
    if (!(durationMs > 0)) durationMs = 5 * 3600 * 1000;

    var penaltySec = cfg.penalty != null ? num(cfg.penalty) : 1200;
    if (penaltySec > 0 && penaltySec < 61) penaltySec = penaltySec * 60; // 少数数据用分钟

    var frozenSec = num(
      cfg.frozen_time != null ? cfg.frozen_time :
      cfg.freeze_time != null ? cfg.freeze_time :
      (cfg.frozen_duration != null ? cfg.frozen_duration : 0)
    );

    var unitRaw = String((cfg.options && cfg.options.submission_timestamp_unit) || cfg.submission_timestamp_unit || 'millisecond').toLowerCase();
    var unit = /^(s|sec|secs|second|seconds|秒)$/.test(unitRaw) ? 1000 : 1;

    var medalSrc = (cfg.medal && (cfg.medal.official || cfg.medal)) || cfg.medals || null;
    var medals = null;
    if (medalSrc) {
      var g = num(medalSrc.gold, -1), s = num(medalSrc.silver, -1), b = num(medalSrc.bronze, -1);
      if (g >= 0 || s >= 0 || b >= 0) medals = { gold: Math.max(0, g), silver: Math.max(0, s), bronze: Math.max(0, b) };
    }

    var groups = cfg.group || {};
    return {
      name: normText(cfg.contest_name || cfg.name || cfg.title) || '未命名比赛',
      shortName: normText(cfg.contest_name_short || ''),
      startMs: startMs,
      endMs: endMs || (startMs + durationMs),
      durationMs: durationMs,
      penaltyMin: Math.round(penaltySec / 60) || 20,
      frozenMs: frozenSec * 1000,
      unit: unit,
      medals: medals,
      logo: normText(cfg.logo && (cfg.logo.url || cfg.logo.preset)) || '',
      officialLabel: normText(groups.official) || '正式队伍',
      unofficialLabel: normText(groups.unofficial) || '打星队伍',
      raw: cfg
    };
  }

  /* ---------------- 题目 ---------------- */
  function normalizeProblems(cfg, contest) {
    cfg = cfg || {};
    if (Array.isArray(cfg.problems) && cfg.problems.length) {
      return cfg.problems.map(function (p, i) {
        var color = '';
        if (p.balloon_color) color = p.balloon_color.background_color || p.balloon_color.color || '';
        else if (p.color) color = p.color;
        return {
          id: String(p.id != null ? p.id : i),
          label: String(p.label != null ? p.label : (i + 1)),
          color: color,
          title: normText(p.title || p.name || '')
        };
      });
    }
    var labels = cfg.problem_id || cfg.problem_ids || cfg.problems || [];
    if (!Array.isArray(labels)) labels = [];
    var colors = cfg.balloon_color || [];
    return labels.map(function (label, i) {
      var c = colors[i];
      var color = '';
      if (typeof c === 'string') color = c;
      else if (c) color = c.background_color || c.color || '';
      return {
        id: String(i),
        label: String(label),
        color: color,
        title: normText((cfg.problem_name && cfg.problem_name[i]) || '')
      };
    });
  }

  /* ---------------- 队伍 ---------------- */
  function normalizeTeams(raw) {
    var arr = Array.isArray(raw) ? raw : (raw ? Object.keys(raw).map(function (k) {
      var t = raw[k];
      if (t && typeof t === 'object' && t.id == null && t.team_id == null) t.team_id = k;
      return t;
    }) : []);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (!t || typeof t !== 'object') continue;
      var id = t.team_id != null ? t.team_id : (t.id != null ? t.id : 'team-' + i);
      id = String(id);
      var groups = Array.isArray(t.group) ? t.group.map(String) : (typeof t.group === 'string' ? [t.group] : []);
      var gtext = groups.join('|');
      var unofficial = t.unofficial === true || /unofficial|打星|starred/i.test(gtext);
      var official = t.official === true || !unofficial;
      var girl = t.girl === true || /girl|女/i.test(gtext);
      out.push({
        id: id,
        name: normText(t.name || t.team_name || t.team) || id,
        org: normText(t.organization || t.school || t.university || t.org || ''),
        official: official,
        unofficial: unofficial,
        girl: girl,
        members: normPeople(t.members || t.team_members || []),
        coaches: normPeople(t.coaches || t.coach || []),
        location: normText(t.location || t.seat || ''),
        icpcId: normText(t.icpc_id || '')
      });
    }
    // 去重
    var seen = new Set();
    return out.filter(function (t) {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }

  /* ---------------- 提交 ---------------- */
  function normalizeStatus(s) {
    var v = String(s == null ? '' : s).toUpperCase().replace(/[\s-]+/g, '_');
    if (AC_STATES.indexOf(v) >= 0) return { st: 'AC', raw: v };
    if (PENDING_STATES.indexOf(v) >= 0) return { st: 'PD', raw: v };
    var map = {
      WRONG_ANSWER: 'WA', WA: 'WA', REJECTED: 'WA', FAILED: 'WA', NO: 'WA', '0': 'WA',
      TIME_LIMIT_EXCEEDED: 'TLE', TLE: 'TLE', MLE: 'MLE', MEMORY_LIMIT_EXCEEDED: 'MLE',
      RUNTIME_ERROR: 'RE', RE: 'RE', COMPILATION_ERROR: 'CE', CE: 'CE',
      PRESENTATION_ERROR: 'PE', PE: 'PE', OUTPUT_LIMIT_EXCEEDED: 'OLE',
      IDLENESS_LIMIT_EXCEEDED: 'ILE', WRONG_ANSWER_OR_TLE: 'WA', HACKED: 'WA',
      JUDGEMENT_FAILED: 'FAILED', JUDGE_FAILED: 'FAILED', SYSTEM_ERROR: 'FAILED', UNKNOWN_ERROR: 'FAILED'
    };
    if (map[v]) return { st: map[v], raw: v };
    return { st: 'WA', raw: v || 'UNKNOWN' };
  }

  function normalizeRuns(rawRuns, problems, contest) {
    if (!Array.isArray(rawRuns)) rawRuns = [];
    var byLabel = new Map();
    var byId = new Map();
    problems.forEach(function (p, i) { byLabel.set(p.label, i); byId.set(p.id, i); });

    var unit = contest.unit || 1;
    var startMs = contest.startMs || 0;
    var out = [];
    for (var i = 0; i < rawRuns.length; i++) {
      var r = rawRuns[i];
      if (!r || typeof r !== 'object') continue;
      var pid = r.problem_id != null ? r.problem_id : (r.problemId != null ? r.problemId : r.problem);
      var idx = -1;
      if (pid != null) {
        var key = String(pid);
        if (byId.has(key)) idx = byId.get(key);
        else if (byLabel.has(key)) idx = byLabel.get(key);
        else if (/^\d+$/.test(key)) {
          var n = parseInt(key, 10);
          if (n >= 0 && n < problems.length) idx = n;
        }
      }
      if (idx < 0) continue;

      var teamId = r.team_id != null ? r.team_id : (r.teamId != null ? r.teamId : r.team);
      if (teamId == null) continue;

      var rawTs = num(r.timestamp != null ? r.timestamp : (r.time != null ? r.time : r.submit_time), 0);
      var ts = rawTs * unit;
      if (ts > 1e12 && startMs) ts = ts - startMs;
      if (ts < 0) ts = 0;

      var status = normalizeStatus(r.status != null ? r.status : (r.verdict != null ? r.verdict : r.result));
      out.push({
        teamId: String(teamId),
        p: idx,
        realTs: ts,
        st: status.st,
        raw: status.raw,
        id: r.id != null ? String(r.id) : '',
        language: normText(r.language || ''),
        manual: false
      });
    }
    out.sort(function (a, b) { return a.realTs - b.realTs; });
    return out;
  }

  /* ---------------- 组装数据集 ---------------- */
  function buildDataset(payload) {
    var contest = normalizeContest(payload.config || payload.contest);
    var problems = normalizeProblems(payload.config || payload.contest, contest);
    var teams = normalizeTeams(payload.teams);
    var runs = normalizeRuns(payload.runs, problems, contest);
    if (!problems.length) {
      // 题目信息缺失时用提交里出现过的标签兜底
      var seen = new Set();
      runs.forEach(function (r) { seen.add(r.p); });
      problems = Array.from(seen).sort(function (a, b) { return a - b; }).map(function (i) {
        return { id: String(i), label: String(i + 1), color: '', title: '' };
      });
    }
    return {
      contest: contest,
      problems: problems,
      teams: teams,
      runs: runs,
      myTeam: null,
      myRuns: [],
      source: payload.source || ''
    };
  }

  /* ---------------- 时间轴缩放 ---------------- */
  function scaleFor(contest, mode) {
    if (mode !== '3h') return 1;
    if (!contest.durationMs || contest.durationMs <= 0) return 1;
    // 只压缩不拉伸：短于 3 小时的比赛在 3 小时模式下按 1:1 回放
    return Math.min(1, (3 * 3600 * 1000) / contest.durationMs);
  }

  function buildView(dataset, mode) {
    var contest = dataset.contest;
    var scale = scaleFor(contest, mode);
    var virtualDuration = contest.durationMs * scale;
    var freezeStart = Math.max(0, virtualDuration - contest.frozenMs * scale);

    var teams = dataset.teams.slice();
    var myId = dataset.myTeam ? dataset.myTeam.id : null;
    if (dataset.myTeam && dataset.myTeam.custom) {
      /* 本地自己建的队伍一律算正式队伍，不然勾了「只看正式队伍」会把自己过滤掉 */
      dataset.myTeam.official = true;
      dataset.myTeam.unofficial = false;
    }
    if (dataset.myTeam && !teams.some(function (t) { return t.id === myId; })) teams.push(dataset.myTeam);

    var runs = [];
    for (var i = 0; i < dataset.runs.length; i++) {
      var r = dataset.runs[i];
      runs.push({
        teamId: r.teamId, p: r.p,
        t: r.realTs * scale,
        realTs: r.realTs,
        st: r.st, raw: r.raw, manual: false
      });
    }
    for (var j = 0; j < (dataset.myRuns || []).length; j++) {
      var m = dataset.myRuns[j];
      runs.push({
        teamId: m.teamId || myId, p: m.p,
        t: m.t,
        realTs: m.realTs != null ? m.realTs : m.t,
        st: m.st, raw: m.raw || m.st, manual: true,
        note: m.note || ''
      });
    }
    runs.sort(function (a, b) { return a.t - b.t; });

    var byTeam = new Map();
    var teamIndex = new Map();
    teams.forEach(function (t, i) { teamIndex.set(t.id, i); });
    for (var k = 0; k < runs.length; k++) {
      var run = runs[k];
      if (!teamIndex.has(run.teamId)) continue;
      var m2 = byTeam.get(run.teamId);
      if (!m2) { m2 = []; byTeam.set(run.teamId, m2); }
      var list = m2[run.p];
      if (!list) { list = []; m2[run.p] = list; }
      list.push(run);
    }

    return {
      contest: contest,
      problems: dataset.problems,
      teams: teams,
      runs: runs,
      byTeam: byTeam,
      scale: scale,
      mode: mode,
      virtualDuration: virtualDuration,
      freezeStart: freezeStart,
      myTeamId: myId
    };
  }

  /* ---------------- 榜单计算 ---------------- */
  function computeStandings(view, elapsed, frozen, opts) {
    opts = opts || {};
    var P = view.problems.length;
    var penaltyPer = view.contest.penaltyMin;
    var rows = [];

    for (var i = 0; i < view.teams.length; i++) {
      var team = view.teams[i];
      if (opts.onlyOfficial && !team.official) continue;
      var tmap = view.byTeam.get(team.id);
      var cells = new Array(P);
      var solved = 0, penalty = 0, lastAc = -1, firstBlood = {};

      for (var p = 0; p < P; p++) {
        var list = tmap && tmap[p];
        if (!list || !list.length) { cells[p] = { state: 'none' }; continue; }
        var ac = null, wrong = 0, pending = false, hidden = false;
        for (var k = 0; k < list.length; k++) {
          var run = list[k];
          if (run.t > elapsed) break;
          if (frozen && run.t > view.freezeStart) { hidden = true; continue; }
          if (run.st === 'AC') { ac = run; break; }
          if (run.st === 'PD') { pending = true; continue; }
          if (run.st === 'CE') { continue; }   /* 编译错误不算罚时，也不占格子 */
          wrong++;
        }
        if (ac) {
          var mins = Math.floor((ac.manual ? ac.t : ac.realTs) / 60000);
          solved++;
          penalty += mins + wrong * penaltyPer;
          if (ac.t > lastAc) lastAc = ac.t;
          cells[p] = {
            state: 'AC', attempts: wrong, minutes: mins,
            virtualMin: Math.floor(ac.t / 60000), t: ac.t, manual: !!ac.manual
          };
        } else if (pending) {
          cells[p] = { state: 'PD', attempts: wrong };
        } else if (hidden && frozen) {
          cells[p] = { state: 'FZ', attempts: wrong };
        } else if (wrong > 0) {
          cells[p] = { state: 'WA', attempts: wrong };
        } else {
          cells[p] = { state: 'none' };
        }
      }

      rows.push({
        team: team, solved: solved, penalty: penalty, lastAc: lastAc, cells: cells,
        rank: 0, officialRank: 0, medal: null
      });
    }

    rows.sort(function (a, b) {
      if (b.solved !== a.solved) return b.solved - a.solved;
      if (a.penalty !== b.penalty) return a.penalty - b.penalty;
      if (a.lastAc !== b.lastAc) return a.lastAc - b.lastAc;
      return compareName(a.team.name, b.team.name);
    });

    var medals = view.contest.medals;
    var officialCount = 0;
    for (var r = 0; r < rows.length; r++) {
      rows[r].rank = r + 1;
      if (rows[r].team.official) {
        officialCount++;
        rows[r].officialRank = officialCount;
        if (medals) {
          if (officialCount <= medals.gold) {
            rows[r].medal = 'gold';
          } else if (officialCount <= medals.gold + medals.silver) {
            rows[r].medal = 'silver';
            if (officialCount === medals.gold + 1) rows[r].tierStart = 'silver';
          } else if (officialCount <= medals.gold + medals.silver + medals.bronze) {
            rows[r].medal = 'bronze';
            if (officialCount === medals.gold + medals.silver + 1) rows[r].tierStart = 'bronze';
          }
        }
      }
    }
    return { rows: rows, total: rows.length, medals: medals };
  }

  /* ---------------- 格式化 ---------------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtClock(ms) {
    ms = Math.max(0, Math.floor(ms));
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  function fmtHMS(ms) {
    ms = Math.max(0, Math.floor(ms));
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h + ':' + pad(m) + ':' + pad(s);
  }

  function fmtMinutes(ms) { return String(Math.floor(ms / 60000)); }

  function parseTimeToMs(text) {
    if (!text) return null;
    var s = String(text).trim();
    if (!s) return null;
    var m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) {
      if (m[3] != null) {
        return (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000;
      }
      return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
    }
    if (/^\d+$/.test(s)) return parseInt(s, 10) * 60 * 1000;
    return null;
  }

  function statusLabel(cell) {
    switch (cell.state) {
      case 'AC': return '通过';
      case 'WA': return '未通过';
      case 'FZ': return '封榜';
      case 'PD': return '判题中';
      default: return '';
    }
  }

  return {
    ME_ID: ME_ID,
    normText: normText,
    normalizeContest: normalizeContest,
    normalizeProblems: normalizeProblems,
    normalizeTeams: normalizeTeams,
    normalizeRuns: normalizeRuns,
    normalizeStatus: normalizeStatus,
    buildDataset: buildDataset,
    scaleFor: scaleFor,
    buildView: buildView,
    computeStandings: computeStandings,
    fmtClock: fmtClock,
    fmtHMS: fmtHMS,
    fmtMinutes: fmtMinutes,
    parseTimeToMs: parseTimeToMs,
    statusLabel: statusLabel,
    compareName: compareName
  };
});
