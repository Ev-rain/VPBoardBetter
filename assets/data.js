/* ============================================================
   data.js — 榜单数据加载（在线 XCPCIO / 本地文件 / 代理兜底）
   ============================================================ */
(function (root) {
  'use strict';

  var HOSTS = [
    { name: 'board.xcpcio.com', base: 'https://board.xcpcio.com/data/' },
    { name: 'xcpcio.github.io', base: 'https://xcpcio.github.io/board-data/data/' }
  ];
  var PROXY_HOSTS = ['board.xcpcio.com', 'xcpcio.github.io'];
  var TIMEOUT = 15000;

  var serverInfo = { checked: false, available: false, version: '', build: '', features: [], qoj: false };

  function fetchText(url, timeout) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeout || TIMEOUT);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .finally(function () { clearTimeout(timer); });
  }

  function parseJson(text, label) {
    try { return JSON.parse(text); }
    catch (e) { throw new Error(label + ' 不是合法 JSON（' + e.message + '）'); }
  }

  function cleanPath(p) {
    return String(p || '').trim().replace(/^\/+/, '').replace(/\/+$/, '').replace(/^data\//, '');
  }

  function candidateBases(input) {
    var u = String(input || '').trim();
    if (!u) return [];
    if (!/^https?:\/\//i.test(u)) {
      var p = cleanPath(u);
      if (!p) return [];
      return HOSTS.map(function (h) { return h.base + p + '/'; });
    }
    var base = u;
    if (/\.json(\?|#|$)/i.test(base)) base = base.replace(/[^/]*$/, '');
    if (!/\/$/.test(base)) base += '/';
    var out = [base];
    try {
      var url = new URL(base);
      var host = url.hostname.replace(/^www\./, '');
      if (host === 'board.xcpcio.com' && !/\/data\//.test(url.pathname)) {
        out.unshift(url.origin + '/data' + url.pathname);
      }
      if (host === 'xcpcio.github.io' && !/\/board-data\//.test(url.pathname)) {
        out.unshift(url.origin + '/board-data' + url.pathname);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function proxyUrl(target) {
    return '/api/proxy?url=' + encodeURIComponent(target);
  }

  function canUseProxy(base) {
    try {
      var host = new URL(base).hostname.replace(/^www\./, '');
      return PROXY_HOSTS.indexOf(host) >= 0;
    } catch (e) { return false; }
  }

  function checkServer() {
    if (serverInfo.checked) return Promise.resolve(serverInfo);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 1200);
    return fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        serverInfo.checked = true;
        serverInfo.available = !!(j && j.ok);
        serverInfo.version = (j && j.version) || '';
        serverInfo.build = (j && j.build) || '';
        serverInfo.features = (j && j.features) || [];
        serverInfo.qoj = !!(j && j.qoj);
      })
      .catch(function () { serverInfo.checked = true; serverInfo.available = false; })
      .finally(function () { clearTimeout(timer); })
      .then(function () { return serverInfo; });
  }

  function synthesizeTeams(runs) {
    var seen = new Map();
    (runs || []).forEach(function (r) {
      var id = String(r && (r.team_id != null ? r.team_id : r.teamId));
      if (!seen.has(id)) seen.set(id, { id: id, name: id, organization: '', group: ['official'] });
    });
    return Array.from(seen.values());
  }

  async function loadBase(base, onStatus) {
    onStatus && onStatus('读取 ' + base + 'config.json …');
    var configText = await fetchText(base + 'config.json');
    var config = parseJson(configText, 'config.json');

    var teamRaw = null, runRaw = null;
    onStatus && onStatus('读取题目队伍与提交记录 …');
    var results = await Promise.allSettled([
      fetchText(base + 'team.json'),
      fetchText(base + 'run.json')
    ]);
    if (results[0].status === 'fulfilled') teamRaw = parseJson(results[0].value, 'team.json');
    if (results[1].status === 'fulfilled') runRaw = parseJson(results[1].value, 'run.json');
    if (!runRaw) {
      throw new Error('run.json 读取失败：' + (results[1].reason && results[1].reason.message || '未知错误'));
    }
    if (Array.isArray(runRaw) === false && runRaw && typeof runRaw === 'object') {
      runRaw = Object.keys(runRaw).map(function (k) { return runRaw[k]; });
    }
    var warned = false;
    if (!teamRaw) {
      teamRaw = synthesizeTeams(runRaw);
      warned = true;
    }
    return { config: config, teams: teamRaw, runs: runRaw, source: base, warned: warned };
  }

  async function loadOnline(input, onStatus) {
    var bases = candidateBases(input);
    if (!bases.length) throw new Error('请填写榜单链接或路径');

    var errors = [];
    for (var i = 0; i < bases.length; i++) {
      var base = bases[i];
      try {
        return await loadBase(base, onStatus);
      } catch (e) {
        errors.push(base.replace(/^https?:\/\//, '') + ' → ' + (e && e.message || e));
      }
    }

    // 直连失败：如果本地启动器在，用代理再试一次（代理能绕过部分网络限制）
    var info = await checkServer();
    if (info.available) {
      for (var j = 0; j < bases.length; j++) {
        var b = bases[j];
        if (!canUseProxy(b)) continue;
        try {
          onStatus && onStatus('直连失败，改用本地服务重试 …');
          var cfgText = await fetchText(proxyUrl(b + 'config.json'));
          var cfg = parseJson(cfgText, 'config.json');
          var pair = await Promise.allSettled([
            fetchText(proxyUrl(b + 'team.json')),
            fetchText(proxyUrl(b + 'run.json'))
          ]);
          var runRaw = pair[1].status === 'fulfilled' ? parseJson(pair[1].value, 'run.json') : null;
          var teamRaw = pair[0].status === 'fulfilled' ? parseJson(pair[0].value, 'team.json') : null;
          if (!runRaw) throw new Error('run.json 代理读取失败');
          if (!teamRaw) teamRaw = synthesizeTeams(runRaw);
          return { config: cfg, teams: teamRaw, runs: runRaw, source: b, viaProxy: true };
        } catch (e2) {
          errors.push('代理 ' + b + ' → ' + (e2 && e2.message || e2));
        }
      }
    }

    var msg = '加载失败：\n' + errors.map(function (s) { return '· ' + s; }).join('\n');
    if (!info.available) msg += '\n提示：用 start.bat 打开后可以走本地服务重试。';
    throw new Error(msg);
  }

  /* ---------------- 本地文件 ---------------- */
  function classifyJson(json) {
    if (Array.isArray(json)) {
      if (!json.length) return 'empty';
      var first = json[0];
      if (first && (first.problem_id != null || first.problemId != null) &&
          (first.team_id != null || first.teamId != null) && (first.status != null || first.verdict != null)) return 'runs';
      if (first && (first.name != null || first.team_id != null)) return 'teams';
      return 'unknown';
    }
    if (json && typeof json === 'object') {
      if (json.problems || json.problem_id || json.start_time || json.contest_name) return 'config';
      var keys = Object.keys(json);
      if (keys.length && json[keys[0]] && typeof json[keys[0]] === 'object' &&
          (json[keys[0]].name != null || json[keys[0]].organization != null)) return 'teams';
    }
    return 'unknown';
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(new Error('读取文件失败：' + file.name)); };
      fr.readAsText(file, 'utf-8');
    });
  }

  async function loadFiles(files) {
    var slot = { config: null, teams: null, runs: null, names: {} };
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var text = await readFileText(f);
      var json = parseJson(text, f.name);
      var kind = classifyJson(json);
      if (kind === 'config') { slot.config = json; slot.names.config = f.name; }
      else if (kind === 'teams') { slot.teams = json; slot.names.teams = f.name; }
      else if (kind === 'runs') { slot.runs = json; slot.names.runs = f.name; }
    }
    var missing = [];
    if (!slot.config) missing.push('config.json');
    if (!slot.runs) missing.push('run.json');
    if (missing.length) throw new Error('缺少文件：' + missing.join('、'));
    if (!slot.teams) slot.teams = synthesizeTeams(slot.runs);
    if (!Array.isArray(slot.runs) && slot.runs && typeof slot.runs === 'object') {
      slot.runs = Object.keys(slot.runs).map(function (k) { return slot.runs[k]; });
    }
    return {
      config: slot.config, teams: slot.teams, runs: slot.runs,
      source: '本地文件' + (slot.names.config ? ' · ' + slot.names.config : '')
    };
  }

  /* ---------------- 本地示例数据（fixtures，用于演示/自测） ---------------- */
  async function loadDemo(basePath, onStatus) {
    var base = String(basePath || '').replace(/\/+$/, '') + '/';
    onStatus && onStatus('读取示例数据 ' + base + ' …');
    var cfgText = await fetchText(base + 'config.json');
    var config = parseJson(cfgText, 'config.json');
    var pair = await Promise.allSettled([fetchText(base + 'team.json'), fetchText(base + 'run.json')]);
    var teamRaw = pair[0].status === 'fulfilled' ? parseJson(pair[0].value, 'team.json') : null;
    var runRaw = pair[1].status === 'fulfilled' ? parseJson(pair[1].value, 'run.json') : null;
    if (!runRaw) throw new Error('示例数据缺少 run.json');
    if (!teamRaw) teamRaw = synthesizeTeams(runRaw);
    return { config: config, teams: teamRaw, runs: runRaw, source: '示例 · ' + base, input: String(basePath) };
  }

  /* ---------------- 最近比赛 ---------------- */
  var RECENT_KEY = 'xcpciovp.recent.v1';

  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function pushRecent(entry) {
    if (!entry || !entry.path) return;
    var list = getRecent().filter(function (x) { return x.path !== entry.path; });
    list.unshift({ path: entry.path, name: entry.name || entry.path, at: Date.now() });
    list = list.slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  root.Data = {
    loadOnline: loadOnline,
    loadFiles: loadFiles,
    loadDemo: loadDemo,
    checkServer: checkServer,
    candidateBases: candidateBases,
    serverInfo: serverInfo,
    getRecent: getRecent,
    pushRecent: pushRecent,
    classifyJson: classifyJson
  };
})(typeof window !== 'undefined' ? window : globalThis);
