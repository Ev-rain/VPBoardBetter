/* ============================================================
   qoj.js — 浏览器端 QOJ 客户端（全部请求交给本地启动器）
   本地启动器负责：登录、抓取表单、提交、轮询评测结果。
   ============================================================ */
(function (root) {
  'use strict';

  var BASE = '/api/qoj';

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('请求超时（' + ms + 'ms）')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  async function post(path, body, ms) {
    var res = await withTimeout(fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }), ms || 30000);
    var json = null;
    try { json = await res.json(); } catch (e) { throw new Error('启动器返回了非 JSON 响应'); }
    if (!res.ok || (json && json.ok === false)) {
      throw new Error((json && (json.error || json.message)) || ('HTTP ' + res.status));
    }
    return json || {};
  }

  async function get(path, ms) {
    var res = await withTimeout(fetch(BASE + path, { cache: 'no-store' }), ms || 30000);
    var json = null;
    try { json = await res.json(); } catch (e) { throw new Error('启动器返回了非 JSON 响应'); }
    if (!res.ok || (json && json.ok === false)) {
      throw new Error((json && (json.error || json.message)) || ('HTTP ' + res.status));
    }
    return json || {};
  }

  root.QOJ = {
    get available() { return !!(root.Data && root.Data.serverInfo && root.Data.serverInfo.qoj); },
    status: function () { return get('/status'); },
    login: function (username, password) { return post('/login', { username: username, password: password }, 160000); },
    logout: function () { return post('/logout', {}, 30000); },
    problems: function (contestUrl) { return post('/problems', { contest: contestUrl }, 60000); },
    contests: function (q, limit, date, days) {
      var url = '/contests?q=' + encodeURIComponent(q || '') + '&limit=' + (limit || 40);
      if (date) url += '&date=' + encodeURIComponent(date) + '&days=' + (days == null ? 2 : days);
      return get(url, 90000);
    },
    submit: function (payload) { return post('/submit', payload, 120000); },
    submission: function (id) { return get('/submission?id=' + encodeURIComponent(id)); },
    editorial: function (contestUrl) { return get('/editorial?contest=' + encodeURIComponent(contestUrl || ''), 90000); }
  };
})(window);
