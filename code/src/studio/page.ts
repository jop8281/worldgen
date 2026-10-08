/**
 * The studio page: one self-contained offline HTML document for the operator, served at `GET /`
 * on the studio port. The six sections — Worlds, Explorer, Generation runs, Eval, Agent Playground,
 * Spend — show only what they fetch at runtime from the studio's own routes. A generation reads an
 * OpenAPI spec or CSV tables under eval/inputs or ones the operator uploads, read as text in the
 * browser and posted to /api/uploads; a generated world's plan opens beside its report.
 *
 * Invariants (the operator-console pattern, `engine/ui.ts`):
 * - Pure. No import, no argument, no build-time value: the document is one constant string, so
 *   no private task material (graders, solutions, decoys) can ever reach it. Every value it
 *   shows is fetched at runtime, same-origin and relative.
 * - Fully offline: inline CSS, vanilla JS, no framework, no build step and no external request.
 *   The document contains no absolute URL at all, so nothing it loads can leave the studio port
 *   it was served from. Links to a running world are built at runtime from the record's port
 *   numbers through `location`, never from a stored or absolute URL.
 * - Rendered strings go through textContent, never innerHTML.
 * - Sign-in is a bearer token the page keeps in sessionStorage and sends as an Authorization header on every
 *   fetch. No cookie: a cookie would ride along to every served world on the host. A 401 or 403 shows in one
 *   error line; the server enforces roles, the page hides nothing.
 * - The studio port is the operator's own. A served world's ports are the agent's boundary and
 *   the page never fetches them: it offers links, and the Explorer's API console sends through
 *   the studio's call route, which reaches only the world port (A-268).
 */
export function studioPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorldGen studio</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 72rem; padding: 1rem 1.25rem 3rem; }
h1 { font-size: 1.3rem; margin: 0; }
h2 { border-bottom: 1px solid #8884; font-size: 1.05rem; margin: 1.6rem 0 0.4rem; padding-bottom: 0.2rem; }
h3 { font-size: 0.95rem; margin: 1rem 0 0.3rem; }
.meta { color: #888; font-size: 0.85rem; margin-left: 0.75rem; }
table { border-collapse: collapse; margin: 0.3rem 0 1rem; max-width: 100%; }
th, td { border: 1px solid #8884; padding: 0.15rem 0.5rem; text-align: left; vertical-align: top; }
th { background: #8881; font-weight: 600; }
td { font-family: ui-monospace, monospace; font-size: 0.85rem; max-width: 32rem; overflow-wrap: anywhere; }
button { cursor: pointer; }
button:disabled { cursor: default; }
input, select, textarea { font: inherit; padding: 0.15rem 0.4rem; }
textarea { width: 100%; }
form p { margin: 0.25rem 0; }
pre { background: #8881; border: 1px solid #8884; margin: 0.3rem 0 1rem; max-height: 24rem; overflow: auto; padding: 0.5rem 0.75rem; white-space: pre-wrap; }
.danger { background: #b00; border: 0; color: #fff; padding: 0.2rem 0.6rem; }
.state { border-radius: 3px; padding: 0.05rem 0.45rem; font-size: 0.85em; background: #e4e7ec; color: #222; }
.state-running, .state-queued { background: #dbe8ff; color: #123a80; }
.state-done { background: #d9f2e3; color: #11592f; }
.state-stopped { background: #fff0cc; color: #6b4b00; }
.state-failed { background: #fbdcdc; color: #7a1010; }
#gen-only label { display: inline-block; margin: 0 1rem 0.2rem 0; font-family: monospace; }
a { margin-right: 0.5rem; }
#signin { margin: 0.5rem 0 0; }
#signin form:not([hidden]) { display: inline; }
#auth-error { color: #b00; margin: 0.25rem 0 0; }
</style>
</head>
<body>
<header>
<h1>WorldGen studio</h1>
<p class="meta">operator app on its own port; a served world keeps its own world and console ports</p>
<div id="signin">
<span id="who">checking sign-in</span>
<button id="signout" type="button" hidden>Sign out</button>
<form id="signin-form" hidden>
<input id="signin-token" type="password" autocomplete="off" placeholder="studio token" aria-label="studio token">
<button type="submit">Sign in</button>
</form>
<p id="auth-error" hidden></p>
</div>
</header>
<nav aria-label="sections">
<a href="#sec-worlds">Worlds</a>
<a href="#sec-explorer">Explorer</a>
<a href="#sec-generation">Generation runs</a>
<a href="#sec-eval">Eval</a>
<a href="#sec-playground">Agent Playground</a>
<a href="#sec-spend">Spend</a>
</nav>
<main>
<section id="sec-worlds">
<h2>Worlds<span id="worlds-meta" class="meta"></span></h2>
<p><button id="worlds-refresh" type="button">refresh</button> <label>filter <input id="worlds-filter" type="search" autocomplete="off" placeholder="world name"></label></p>
<div id="worlds-table"></div>
<pre id="world-report" hidden></pre>
<div id="world-plan" hidden></div>
</section>
<section id="sec-explorer">
<h2>Explorer<span id="explorer-meta" class="meta"></span></h2>
<p><label>world <select id="explorer-world"></select></label> <button id="explorer-load" type="button">explore</button></p>
<div id="explorer-body"></div>
<h3>API console<span id="console-meta" class="meta">one real request to the world port of a served world, never its admin port</span></h3>
<form id="console-form">
<p>
<select id="console-method" aria-label="HTTP method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
<input id="console-path" aria-label="request path" size="48" placeholder="/tickets?status=open">
<button id="console-send" type="submit">send</button>
</p>
<p><label>JSON body, for POST, PUT and PATCH <textarea id="console-body" rows="4"></textarea></label></p>
</form>
<div id="console-result"></div>
</section>
<section id="sec-generation">
<h2>Generation runs</h2>
<form id="generate-form">
<p>
<label>kind
<select id="gen-kind">
<option value="description">description</option>
<option value="openapi">openapi</option>
<option value="csv">csv</option>
</select>
</label>
</p>
<p id="gen-desc-row"><label>description <textarea id="gen-text" rows="3" placeholder="A helpdesk with SLA tiers and on-call escalation"></textarea></label></p>
<div id="gen-openapi-row" hidden>
<p><label>OpenAPI spec under eval/inputs, or uploaded <select id="gen-spec"></select></label></p>
<p><label>upload a spec <input id="gen-spec-file" type="file" accept=".yaml,.yml,.json"></label> <button id="gen-spec-upload" type="button">upload</button> <span id="gen-spec-note" class="meta"></span></p>
<fieldset id="gen-only"><legend>only these paths (--only; none ticked means the whole spec)</legend></fieldset>
</div>
<div id="gen-csv-row" hidden>
<p><label>CSV files under eval/inputs, or uploaded (pick one or more) <select id="gen-csv" multiple size="6"></select></label></p>
<p><label>upload CSV files <input id="gen-csv-file" type="file" accept=".csv" multiple></label> <button id="gen-csv-upload" type="button">upload</button> <span id="gen-csv-note" class="meta"></span></p>
</div>
<p>
<label>out slug <input id="gen-slug" placeholder="helpdesk-demo"></label>
<label>budget usd <input id="gen-budget" type="number" min="0" step="0.01"></label>
<label>max minutes <input id="gen-minutes" type="number" min="0" step="1"></label>
<button id="gen-start" type="submit">generate</button>
</p>
</form>
<div id="run-live"></div>
<h3>Past runs<span id="runs-meta" class="meta"></span></h3>
<div id="runs-table"></div>
</section>
<section id="sec-eval">
<h2>Eval<span id="eval-meta" class="meta"></span></h2>
<div id="eval-table"></div>
<pre id="eval-summary" hidden></pre>
</section>
<section id="sec-playground">
<h2>Agent Playground<span id="play-meta" class="meta">agent episodes on loopback, graded by the engine</span></h2>
<p>
<label>world <select id="play-world"></select></label>
<label>task <select id="play-task"></select></label>
<label>agent
<select id="play-agent">
<option value="noop">noop (finishes at once, free)</option>
<option value="sonnet">sonnet (claude-sonnet-5-5, spends)</option>
</select>
</label>
<label>budget usd <input id="play-budget" type="number" min="0.01" step="0.01" value="0.5"></label>
<label>max turns <input id="play-turns" type="number" min="1" step="1" value="12"></label>
<button id="play-run" type="button">run episode</button>
<button id="play-proof" type="button">engine proof</button>
</p>
<p id="play-instruction" class="meta"></p>
<div id="play-proof-table"></div>
<h3>Episodes<span id="episodes-meta" class="meta"></span></h3>
<div id="episodes-table"></div>
<div id="episode-view"></div>
<h3>Analytics<span id="analytics-meta" class="meta">episodes by world, task and agent model; a success is an engine score of 1 with a reply and known cost</span></h3>
<div id="analytics-table"></div>
</section>
<section id="sec-spend">
<h2>Spend<span id="spend-meta" class="meta">costs --json, cached up to 30 s</span></h2>
<p><button id="spend-refresh" type="button">refresh</button></p>
<div id="spend-body"></div>
</section>
</main>
<script>
(function () {
  'use strict';
  var byId = function (id) { return document.getElementById(id); };

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  // ---- Sign-in: a bearer token in sessionStorage (per origin, so per port), never a cookie ----------
  var TOKEN_KEY = 'studio-token';
  var whoLine = byId('who');
  var signoutBtn = byId('signout');
  var signinForm = byId('signin-form');
  var authError = byId('auth-error');
  function storedToken() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function authHeaders(headers) {
    var token = storedToken();
    if (token) headers.authorization = 'Bearer ' + token;
    return headers;
  }
  /** Shows a 401 or 403 in the error line (and the sign-in form on a 401); other answers clear nothing. */
  function authNote(status, body) {
    if (status !== 401 && status !== 403) return;
    var err = body && body.error ? body.error : {};
    authError.textContent = 'HTTP ' + status + ' ' + err.code + ': ' + err.message;
    authError.hidden = false;
    if (status === 401) {
      signinForm.hidden = false;
      whoLine.textContent = 'not signed in';
    }
  }
  function answered(r) {
    return r.json().then(function (body) { authNote(r.status, body); return body; });
  }
  function getJson(path) { return fetch(path, { headers: authHeaders({}) }).then(answered); }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) })
      .then(answered);
  }
  signinForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var token = byId('signin-token').value;
    if (token === '') return;
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) { authError.textContent = 'this browser blocks sessionStorage, so it cannot keep a token'; authError.hidden = false; return; }
    location.reload();
  });
  signoutBtn.addEventListener('click', function () {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* nothing stored to remove */ }
    location.reload();
  });
  var signedIn = fetch('/api/me', { headers: authHeaders({}) }).then(function (r) {
    return r.json().then(function (body) {
      authNote(r.status, body);
      if (r.status !== 200) return false;
      if (!body.signIn) {
        whoLine.textContent = body.name + ' (' + body.role + '), sign-in off';
        return true;
      }
      whoLine.textContent = body.name + ' (' + body.role + ')';
      signoutBtn.hidden = false;
      return true;
    });
  }, function (e) { whoLine.textContent = 'unreachable: ' + e; return false; });
  /** Downloads a zip the header-less link cannot fetch: with the token, through an object URL. */
  function downloadZip(path, filename) {
    fetch(path, { headers: authHeaders({}) }).then(function (r) {
      if (!r.ok) return answered(r);
      return r.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      });
    }, function (e) { authError.textContent = 'export failed: ' + e; authError.hidden = false; });
  }
  function cell(value) {
    if (value === null || value === undefined) return 'null';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  /** A table for rows of plain objects; a DOM-node value is appended instead of stringified. */
  function grid(cols, rows) {
    var table = document.createElement('table');
    var head = document.createElement('tr');
    for (var c = 0; c < cols.length; c++) head.appendChild(el('th', cols[c]));
    table.appendChild(head);
    for (var r = 0; r < rows.length; r++) {
      var tr = document.createElement('tr');
      for (var k = 0; k < cols.length; k++) {
        var td = document.createElement('td');
        var v = rows[r][cols[k]];
        if (v !== null && v !== undefined && v.nodeType !== undefined) td.appendChild(v);
        else td.textContent = cell(v);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    return table;
  }
  function usd(n) {
    if (n === null || n === undefined) return 'unknown';
    return '$' + Number(n).toFixed(4);
  }
  /** A same-host URL for one of a running world's ports, built from location, never stored. */
  function portUrl(port) { return location.protocol + '//' + location.hostname + ':' + port; }

  // ---- Worlds: the table, Serve / Stop, links, and the report toggle -----------------
  var worldsTable = byId('worlds-table');
  var worldsMeta = byId('worlds-meta');
  var worldReport = byId('world-report');
  var reportWorld = null;
  var worldsFilter = byId('worlds-filter');
  var worldsBase = '';
  var worldsTotal = 0;
  /** Hides the rows whose world name lacks the filter text (case-insensitive); the meta shows shown of total while a filter is set. */
  function applyFilter() {
    var needle = worldsFilter.value.trim().toLowerCase();
    var rows = worldsTable.querySelectorAll('tr');
    var shown = 0;
    for (var i = 1; i < rows.length; i++) {
      var match = rows[i].cells[0].textContent.toLowerCase().indexOf(needle) !== -1;
      rows[i].hidden = !match;
      if (match) shown++;
    }
    worldsMeta.textContent = needle === '' ? worldsBase : shown + ' of ' + worldsTotal;
  }
  worldsFilter.addEventListener('input', applyFilter);
  // ---- The view lives in the URL hash: #world=<name>&view=explorer|report|plan|play, written with replaceState ----
  function setHash(world, view) {
    var params = new URLSearchParams();
    params.set('world', world);
    params.set('view', view);
    try { history.replaceState(null, '', '#' + params.toString()); } catch (e) { /* a blocked history keeps the page working */ }
  }

  function serviceFor(name, services) {
    for (var i = 0; i < services.length; i++) if (services[i].name === name) return services[i];
    return null;
  }
  function toggleReport(name) {
    if (reportWorld === name && !worldReport.hidden) { worldReport.hidden = true; reportWorld = null; return; }
    openReport(name);
  }
  function openReport(name) {
    setHash(name, 'report');
    worldReport.hidden = false;
    worldReport.textContent = 'loading…';
    getJson('/api/worlds/' + encodeURIComponent(name) + '/report').then(function (body) {
      reportWorld = name;
      worldReport.hidden = false;
      worldReport.textContent = body.error !== undefined
        ? body.error.code + ': ' + body.error.message
        : (body.report === null ? 'no REPORT.md for ' + name : body.report);
    }, function (e) { worldReport.hidden = false; worldReport.textContent = 'unreachable: ' + e; });
  }
  // ---- The plan of a generated world: its assumptions, open questions, out of scope, and plan.md ----
  var worldPlan = byId('world-plan');
  var planWorld = null;
  function togglePlan(name) {
    if (planWorld === name && !worldPlan.hidden) { worldPlan.hidden = true; planWorld = null; return; }
    openPlan(name);
  }
  function planList(title, items, text) {
    worldPlan.appendChild(el('h3', title + ' (' + items.length + ')'));
    if (items.length === 0) { worldPlan.appendChild(el('p', 'none')); return; }
    var list = document.createElement('ul');
    items.forEach(function (x) { list.appendChild(el('li', text(x))); });
    worldPlan.appendChild(list);
  }
  function openPlan(name) {
    setHash(name, 'plan');
    worldPlan.hidden = false;
    clear(worldPlan);
    worldPlan.appendChild(el('p', 'loading…'));
    getJson('/api/worlds/' + encodeURIComponent(name) + '/plan').then(function (body) {
      planWorld = name;
      clear(worldPlan);
      if (body.error !== undefined) { worldPlan.appendChild(el('p', body.error.code + ': ' + body.error.message)); return; }
      worldPlan.appendChild(el('h3', 'plan of ' + body.name));
      planList('assumptions', body.assumptions, function (a) { return a.decision + ' (why: ' + a.why + ')'; });
      planList('open questions', body.openQuestions, function (q) { return q.question + ' (default answer: ' + q.default_answer + ')'; });
      planList('out of scope', body.outOfScope, function (o) { return o.what + ' (why: ' + o.why + ')'; });
      worldPlan.appendChild(el('h3', 'plan.md'));
      worldPlan.appendChild(el('pre', body.planMd));
    }, function (e) { clear(worldPlan); worldPlan.appendChild(el('p', 'unreachable: ' + e)); });
  }
  function refreshWorlds() {
    worldsMeta.textContent = 'loading…';
    return Promise.all([getJson('/api/worlds'), getJson('/api/services')]).then(function (pair) {
      var worlds = pair[0].worlds || [];
      var services = pair[1].services || [];
      worldsTotal = worlds.length;
      worldsBase = worlds.length + ' world(s), ' + services.length + ' served';
      worldsMeta.textContent = worldsBase;
      clear(worldsTable);
      if (worlds.length === 0) { worldsTable.appendChild(el('p', 'no worlds')); return; }
      var rows = worlds.map(function (w) {
        var svc = serviceFor(w.name, services);
        var actions = document.createElement('span');
        var serveBtn = document.createElement('button');
        serveBtn.type = 'button';
        serveBtn.textContent = svc === null ? 'serve' : 'stop';
        if (svc !== null) serveBtn.className = 'danger';
        serveBtn.addEventListener('click', function () {
          var promise = svc === null
            ? post('/api/worlds/' + encodeURIComponent(w.name) + '/serve', {})
            : post('/api/services/' + encodeURIComponent(svc.id) + '/stop', {});
          promise.then(refreshWorlds, function (e) { worldsMeta.textContent = 'unreachable: ' + e; });
        });
        actions.appendChild(serveBtn);
        if (svc !== null) {
          var api = el('a', 'world api');
          api.href = portUrl(svc.worldPort);
          var consoleLink = el('a', 'console');
          consoleLink.href = portUrl(svc.adminPort);
          actions.appendChild(api);
          actions.appendChild(consoleLink);
        }
        var reportBtn = document.createElement('button');
        reportBtn.type = 'button';
        reportBtn.textContent = 'report';
        reportBtn.addEventListener('click', function () { toggleReport(w.name); });
        actions.appendChild(reportBtn);
        if (w.generated) {
          var planBtn = document.createElement('button');
          planBtn.type = 'button';
          planBtn.textContent = 'plan';
          planBtn.addEventListener('click', function () { togglePlan(w.name); });
          actions.appendChild(planBtn);
        }
        var exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.textContent = 'export';
        exportBtn.addEventListener('click', function () { downloadZip('/api/worlds/' + encodeURIComponent(w.name) + '/export', w.name + '.zip'); });
        actions.appendChild(exportBtn);
        return {
          name: w.name,
          kind: w.generated ? 'generated' : 'hand-built',
          tasks: w.taskCount === null ? 'invalid: ' + w.invalid : w.taskCount,
          wid: w.capsule === undefined ? 'none' : w.capsule.wid,
          model: w.capsule === undefined ? 'none' : w.capsule.model,
          cost: w.capsule === undefined ? 'none' : usd(w.capsule.costUsd),
          attempts: w.capsule === undefined ? 'none' : w.capsule.attempts,
          actions: actions
        };
      });
      worldsTable.appendChild(grid(['name', 'kind', 'tasks', 'wid', 'model', 'cost', 'attempts', 'actions'], rows));
      applyFilter();
    }, function (e) { worldsMeta.textContent = 'unreachable: ' + e; });
  }
  byId('worlds-refresh').addEventListener('click', refreshWorlds);

  // ---- Generation runs: the form, the live panel, and the past runs ------------------
  var runLive = byId('run-live');
  var runsTable = byId('runs-table');
  var runsMeta = byId('runs-meta');
  var liveRun = null;
  var pollTimer = null;

  function runState(text) {
    clear(runLive);
    runLive.appendChild(el('p', text));
  }
  function renderLive(body) {
    clear(runLive);
    var events = body.events || [];
    var head = document.createElement('p');
    var strong = document.createElement('strong');
    strong.textContent = 'run ' + liveRun;
    head.appendChild(strong);
    var chip = document.createElement('span');
    chip.className = 'state state-' + (body.state || 'unknown');
    chip.textContent = (body.state || (body.running ? 'running' : 'finished')) + (body.reason === undefined ? '' : ': ' + body.reason);
    head.appendChild(document.createTextNode(' '));
    head.appendChild(chip);
    if (body.running) {
      var stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'danger';
      stopBtn.textContent = 'stop';
      stopBtn.addEventListener('click', function () {
        post('/api/generate/' + encodeURIComponent(liveRun) + '/stop', {}).then(pollLiveOnce, function (e) { runState('unreachable: ' + e); });
      });
      head.appendChild(stopBtn);
    }
    runLive.appendChild(head);
    var finished = null;
    for (var i = 0; i < events.length; i++) if (events[i].t === 'run_finished') finished = events[i];
    if (finished !== null) {
      runLive.appendChild(el('p', finished.result.kind === 'done'
        ? 'done: the run wrote its world'
        : 'stopped: ' + (finished.result.reason === undefined ? 'unknown reason' : finished.result.reason.kind)));
    }
    var rows = events.slice(-100).map(function (e) {
      return { t: e.t, step: e.step === undefined ? '' : e.step, n: e.n === undefined ? '' : e.n, outcome: e.outcome === undefined ? '' : e.outcome.kind, ms: e.ms === undefined ? '' : e.ms, cost: e.costUsd === undefined ? '' : usd(e.costUsd) };
    });
    if (rows.length > 0) runLive.appendChild(grid(['t', 'step', 'n', 'outcome', 'ms', 'cost'], rows));
    if (body.totals !== null && body.totals !== undefined) {
      runLive.appendChild(el('p', 'totals: ' + body.totals.ms + ' ms, ' + usd(body.totals.costUsd) + ' (the latest ' + events.length + ' event(s) shown of the run)'));
    }
  }
  function pollLiveOnce() {
    return getJson('/api/generate/' + encodeURIComponent(liveRun) + '/events').then(function (body) {
      renderLive(body);
      if (!body.running && pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
        refreshWorlds();
        refreshRuns();
      }
    }, function (e) { runState('unreachable: ' + e); });
  }
  function pollLive() {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollLiveOnce();
    pollTimer = window.setInterval(pollLiveOnce, 2000);
  }
  var inputsLoaded = null;
  var UPLOAD = 'upload:';
  /** The eval/inputs files, then this tenant's uploads as upload:<id>; keeps what was picked, and picks \`picked\`. */
  function loadInputs(picked) {
    var spec = byId('gen-spec');
    var csv = byId('gen-csv');
    var keepSpec = spec.value;
    var keep = Array.prototype.map.call(csv.selectedOptions, function (o) { return o.value; }).concat(picked || []);
    inputsLoaded = Promise.all([getJson('/api/inputs'), getJson('/api/uploads')]).then(function (pair) {
      var uploads = pair[1].uploads || [];
      function options(files, kind) {
        return files.map(function (f) { return { value: f, label: f }; }).concat(uploads
          .filter(function (u) { return u.kind === kind; })
          .map(function (u) { return { value: UPLOAD + u.id, label: 'uploaded: ' + u.name }; }));
      }
      fill(spec, options(pair[0].openapi || [], 'openapi'));
      fill(csv, options(pair[0].csv || [], 'csv'));
      var specPick = (picked || []).concat([keepSpec]).filter(function (v) { return hasOption(spec, v); });
      if (specPick.length > 0) spec.value = specPick[0];
      Array.prototype.forEach.call(csv.options, function (o) { o.selected = keep.indexOf(o.value) !== -1; });
      loadPaths();
    });
    return inputsLoaded;
  }
  /** Uploads each chosen file as \`kind\`, one at a time, says how each went, then lists the uploads with the new ones picked. */
  function uploadChosen(kind, input, note) {
    var files = Array.prototype.slice.call(input.files || []);
    if (files.length === 0) { note.textContent = 'choose a file first'; return; }
    note.textContent = 'uploading ' + files.length + ' file(s)…';
    var said = [];
    var picked = [];
    files.reduce(function (chain, f) {
      return chain.then(function () { return f.text(); }).then(function (content) {
        return post('/api/uploads', { kind: kind, name: f.name, content: content });
      }).then(function (r) {
        if (r.error !== undefined) { said.push(f.name + ': ' + r.error.code + ': ' + r.error.message); return; }
        picked.push(UPLOAD + r.upload.id);
        said.push('uploaded ' + r.upload.name + ' (' + r.upload.bytes + ' bytes)');
      });
    }, Promise.resolve()).then(function () {
      note.textContent = said.join('; ');
      input.value = '';
      return loadInputs(picked);
    }, function (e) { note.textContent = 'upload failed: ' + e; });
  }
  byId('gen-spec-upload').addEventListener('click', function () { uploadChosen('openapi', byId('gen-spec-file'), byId('gen-spec-note')); });
  byId('gen-csv-upload').addEventListener('click', function () { uploadChosen('csv', byId('gen-csv-file'), byId('gen-csv-note')); });
  function loadPaths() {
    var only = byId('gen-only');
    var legend = only.querySelector('legend');
    clear(only);
    only.appendChild(legend);
    var spec = byId('gen-spec').value;
    if (spec === '') return;
    var source = spec.indexOf(UPLOAD) === 0
      ? '/api/uploads/' + encodeURIComponent(spec.slice(UPLOAD.length)) + '/paths'
      : '/api/inputs/' + encodeURIComponent(spec) + '/paths';
    getJson(source).then(function (body) {
      if (body.error !== undefined) { only.appendChild(el('p', body.error.code + ': ' + body.error.message)); return; }
      body.paths.forEach(function (p) {
        var label = document.createElement('label');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.value = p;
        box.name = 'gen-only-path';
        box.setAttribute('aria-label', 'only ' + p);
        label.appendChild(box);
        label.appendChild(document.createTextNode(' ' + p));
        only.appendChild(label);
      });
    }, function (e) { only.appendChild(el('p', 'unreachable: ' + e)); });
  }
  function showKind() {
    var kind = byId('gen-kind').value;
    byId('gen-desc-row').hidden = kind !== 'description';
    byId('gen-openapi-row').hidden = kind !== 'openapi';
    byId('gen-csv-row').hidden = kind !== 'csv';
    if (kind !== 'description' && inputsLoaded === null) loadInputs([]);
  }
  byId('gen-kind').addEventListener('change', showKind);
  byId('gen-spec').addEventListener('change', loadPaths);
  byId('generate-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var kind = byId('gen-kind').value;
    var body = { kind: kind, outSlug: byId('gen-slug').value.trim() };
    if (kind === 'description') body.text = byId('gen-text').value;
    if (kind === 'openapi') {
      var spec = byId('gen-spec').value;
      if (spec.indexOf(UPLOAD) === 0) body.upload = spec.slice(UPLOAD.length);
      else body.spec = spec;
      body.only = Array.prototype.map.call(document.querySelectorAll('input[name="gen-only-path"]:checked'), function (b) { return b.value; });
    }
    if (kind === 'csv') {
      var picked = Array.prototype.map.call(byId('gen-csv').selectedOptions, function (o) { return o.value; });
      body.files = picked.filter(function (v) { return v.indexOf(UPLOAD) !== 0; });
      var uploaded = picked.filter(function (v) { return v.indexOf(UPLOAD) === 0; }).map(function (v) { return v.slice(UPLOAD.length); });
      if (uploaded.length > 0) body.uploads = uploaded;
    }
    var budget = byId('gen-budget').value;
    var minutes = byId('gen-minutes').value;
    if (budget !== '') body.budgetUsd = Number(budget);
    if (minutes !== '') body.maxMinutes = Number(minutes);
    post('/api/generate', body).then(function (r) {
      if (r.error !== undefined) { runState(r.error.code + ': ' + r.error.message); return; }
      liveRun = r.runId;
      runState('run ' + r.runId + ' started, writing ' + r.outDir);
      pollLive();
    }, function (e) { runState('unreachable: ' + e); });
  });
  function refreshRuns() {
    runsMeta.textContent = 'loading…';
    return getJson('/api/runs').then(function (body) {
      var past = body.runs || [];
      runsMeta.textContent = past.length + ' run(s)';
      clear(runsTable);
      if (past.length === 0) { runsTable.appendChild(el('p', 'no runs')); return; }
      var rows = past.map(function (r) {
        return { world: r.name, 'run id': r.runId, model: r.model, transport: r.transport, cost: usd(r.costUsd), ms: r.ms, outcome: r.outcome };
      });
      runsTable.appendChild(grid(['world', 'run id', 'model', 'transport', 'cost', 'ms', 'outcome'], rows));
    }, function (e) { runsMeta.textContent = 'unreachable: ' + e; });
  }

  // ---- Eval: the run list with the pass-rate line, and the summary toggle ------------
  var evalTable = byId('eval-table');
  var evalMeta = byId('eval-meta');
  var evalSummary = byId('eval-summary');
  var evalDir = null;

  function toggleEval(dir) {
    if (evalDir === dir && !evalSummary.hidden) { evalSummary.hidden = true; evalDir = null; return; }
    getJson('/api/eval/' + encodeURIComponent(dir)).then(function (body) {
      evalDir = dir;
      evalSummary.hidden = false;
      evalSummary.textContent = body.error !== undefined ? body.error.code + ': ' + body.error.message : body.summary;
    }, function (e) { evalSummary.hidden = false; evalSummary.textContent = 'unreachable: ' + e; });
  }
  function refreshEval() {
    evalMeta.textContent = 'loading…';
    return getJson('/api/eval').then(function (body) {
      var runs = body.runs || [];
      evalMeta.textContent = runs.length + ' eval run(s)';
      clear(evalTable);
      if (runs.length === 0) { evalTable.appendChild(el('p', 'no eval runs')); return; }
      var rows = runs.map(function (r) {
        var m = /^(\\d{4}-\\d{2}-\\d{2})-(.+)$/.exec(r.dir);
        var pass = 'none';
        var lines = r.summaryFirstLines || [];
        for (var i = 0; i < lines.length; i++) if (lines[i].indexOf('**Pass rate:**') === 0) pass = lines[i].slice('**Pass rate:**'.length).trim();
        var view = document.createElement('button');
        view.type = 'button';
        view.textContent = 'view';
        view.addEventListener('click', function () { toggleEval(r.dir); });
        return { name: r.dir, date: m === null ? '-' : m[1], 'pass rate': pass, '': view };
      });
      evalTable.appendChild(grid(['name', 'date', 'pass rate', ''], rows));
    }, function (e) { evalMeta.textContent = 'unreachable: ' + e; });
  }

  // ---- Spend: the meters, the by-day rows and the caps, from costs --json -------------
  var spendBody = byId('spend-body');
  var spendMeta = byId('spend-meta');

  function refreshSpend() {
    spendMeta.textContent = 'loading…';
    return getJson('/api/costs').then(function (body) {
      clear(spendBody);
      var m = body.meters || {};
      spendBody.appendChild(el('h3', 'meters (today is ' + (m.day === undefined ? '?' : m.day) + ' UTC)'));
      var meterRows = ['llm', 'sandbox', 'total'].map(function (k) {
        var one = m[k] === undefined ? {} : m[k];
        var today = one.today === undefined ? {} : one.today;
        var allTime = one.allTime === undefined ? {} : one.allTime;
        return { kind: k, today: usd(today.usd), 'all time': usd(allTime.usd), 'today events': today.events, 'all time events': allTime.events };
      });
      spendBody.appendChild(grid(['kind', 'today', 'all time', 'today events', 'all time events'], meterRows));
      spendBody.appendChild(el('h3', 'by day'));
      var rows = (body.rows || []).map(function (r) { return { day: r.key, usd: usd(r.usd), events: r.events }; });
      if (rows.length === 0) spendBody.appendChild(el('p', 'no spend recorded'));
      else spendBody.appendChild(grid(['day', 'usd', 'events'], rows));
      var caps = body.caps || {};
      var names = Object.keys(caps).filter(function (n) { return n !== 'day'; });
      if (names.length > 0) {
        spendBody.appendChild(el('h3', 'caps'));
        var capRows = names.map(function (n) {
          var c = caps[n];
          return c === null || c === undefined
            ? { cap: n, 'cap usd': 'none (set it in the environment)', 'spent usd': '-', 'remaining usd': '-' }
            : { cap: n, 'cap usd': usd(c.capUsd), 'spent usd': usd(c.spentUsd), 'remaining usd': usd(c.remainingUsd) };
        });
        spendBody.appendChild(grid(['cap', 'cap usd', 'spent usd', 'remaining usd'], capRows));
      }
      spendMeta.textContent = 'costs --json, cached up to 30 s';
    }, function (e) { spendMeta.textContent = 'unreachable: ' + e; });
  }
  byId('spend-refresh').addEventListener('click', refreshSpend);

  var playWorld = byId('play-world');
  var playTask = byId('play-task');
  var playMeta = byId('play-meta');
  var playInstruction = byId('play-instruction');
  var proofTable = byId('play-proof-table');
  var episodesTable = byId('episodes-table');
  var episodesMeta = byId('episodes-meta');
  var episodeView = byId('episode-view');
  var PLAY_META = playMeta.textContent;
  var playTasks = [];
  var watching = null;
  function fill(select, values) {
    clear(select);
    values.forEach(function (v) { var o = el('option', v.label); o.value = v.value; select.appendChild(o); });
  }
  function showInstruction() {
    var t = playTasks.filter(function (x) { return x.id === playTask.value; })[0];
    playInstruction.textContent = t ? '[' + (t.difficulty || '?') + '] ' + t.instruction : '';
  }
  function loadTasks() {
    if (!playWorld.value) return Promise.resolve();
    playMeta.textContent = 'loading…';
    return getJson('/api/worlds/' + encodeURIComponent(playWorld.value) + '/tasks').then(function (body) {
      playTasks = body.tasks || [];
      fill(playTask, playTasks.map(function (t) { return { value: t.id, label: t.id }; }));
      showInstruction();
      clear(proofTable);
      playMeta.textContent = PLAY_META;
    }, function (e) { playMeta.textContent = 'unreachable: ' + e; });
  }
  function loadPlayWorlds() {
    return getJson('/api/worlds').then(function (body) {
      fill(playWorld, (body.worlds || []).map(function (w) { return { value: w.name, label: w.name }; }));
      return loadTasks();
    }, function (e) { playMeta.textContent = 'unreachable: ' + e; });
  }
  playWorld.addEventListener('change', function () { if (playWorld.value !== '') setHash(playWorld.value, 'play'); loadTasks(); });
  playTask.addEventListener('change', showInstruction);
  byId('play-proof').addEventListener('click', function () {
    clear(proofTable);
    proofTable.appendChild(el('p', 'proving ' + playWorld.value + ' with worldplay verify...'));
    post('/api/worlds/' + encodeURIComponent(playWorld.value) + '/proof', {}).then(function (body) {
      clear(proofTable);
      if (body.error) { proofTable.appendChild(el('p', body.error.code + ': ' + body.error.message)); return; }
      var rows = (body.tasks || []).map(function (r) {
        var p = r.proof || {};
        return {
          task: r.task, difficulty: r.difficulty,
          reference: p.reference ? p.reference.score : '-',
          noop: p.noop ? p.noop.score : '-',
          'near miss': p.near_miss ? p.near_miss.score : '-',
          'wrong (decoys)': (p.decoys || []).join(', '),
          replay: p.replay_identical === true ? 'identical' : String(p.replay_identical)
        };
      });
      proofTable.appendChild(el('p', body.verified ? 'engine proof: every task verified' : 'engine proof: verify reported a failure'));
      proofTable.appendChild(grid(['task', 'difficulty', 'reference', 'noop', 'near miss', 'wrong (decoys)', 'replay'], rows));
    }, function (e) { clear(proofTable); proofTable.appendChild(el('p', 'unreachable: ' + e)); });
  });
  function clip(v) { var t = typeof v === 'string' ? v : JSON.stringify(v); return t === undefined ? '' : (t.length > 600 ? t.slice(0, 600) + ' ...' : t); }
  /** One public message as text: the instruction, a request the agent made, the world's answer, or the final reply. */
  function messageText(m) {
    if (m.type === 'instruction' || m.type === 'final_reply') return m.text + (m.commentary ? '  [' + m.commentary + ']' : '');
    if (m.type === 'tool_call') {
      var r = m.request || {};
      var keys = r.query ? Object.keys(r.query) : [];
      var q = keys.length > 0 ? '?' + keys.map(function (k) { return k + '=' + r.query[k]; }).join('&') : '';
      return r.method + ' ' + r.path + q + (r.body === undefined ? '' : ' ' + clip(r.body)) + (m.commentary ? '  [' + m.commentary + ']' : '');
    }
    if (m.type === 'tool_result') return m.outcome + (m.status === null ? '' : ' ' + m.status) + ' ' + clip(m.body) + (m.truncated ? ' (truncated)' : '') + (m.detail ? ' - ' + m.detail : '');
    return clip(m);
  }
  function renderEpisode(body) {
    clear(episodeView);
    var head = body.runId + (body.running ? ' (running)' : '');
    episodeView.appendChild(el('h3', 'episode ' + head));
    if (body.failure) episodeView.appendChild(el('pre', body.failure.join('\\n')));
    var e = body.episode;
    if (!e) { episodeView.appendChild(el('p', body.running ? 'running: the export appears when the episode is graded' : 'no exported episode')); return; }
    episodeView.appendChild(grid(['task', 'agent model', 'stop reason', 'engine score', 'score scope', 'cost usd', 'final reply'], [{
      task: e.task_id, 'agent model': e.model === null ? 'noop (no model)' : e.model, 'stop reason': e.stop_reason,
      'engine score': e.score === null ? 'none' : e.score, 'score scope': e.score_scope,
      'cost usd': usd(e.usage ? e.usage.cost_usd : 0), 'final reply': e.final_reply === null ? '' : e.final_reply
    }]));
    episodeView.appendChild(el('p', 'a correct final reply and a correct end state are separate claims: the engine score grades only the end state'));
    var turns = (e.messages || []).map(function (m, i) {
      return { '#': m.seq === undefined ? i : m.seq, role: m.role, type: m.type, content: messageText(m) };
    });
    episodeView.appendChild(grid(['#', 'role', 'type', 'content'], turns));
    episodeView.appendChild(el('p', 'world ' + e.world_id + ' ' + String(e.world_version).slice(0, 12) + ' · engine ' + String(e.engine_commit).slice(0, 12) + ' · seed state ' + String(e.initial_state_hash).slice(0, 12) + ' -> end state ' + String(e.final_state_hash).slice(0, 12)));
  }
  function showEpisode(runId) {
    return getJson('/api/episodes/' + encodeURIComponent(runId)).then(function (body) {
      renderEpisode(body);
      if (body.running && watching === runId) setTimeout(function () { showEpisode(runId); }, 2000);
      else if (watching === runId) { watching = null; refreshEpisodes(); }
    }, function (e) { episodeView.textContent = 'unreachable: ' + e; });
  }
  var analyticsTable = byId('analytics-table');
  var analyticsMeta = byId('analytics-meta');
  var ANALYTICS_META = analyticsMeta.textContent;
  function refreshAnalytics() {
    analyticsMeta.textContent = 'loading…';
    return getJson('/api/episodes/analytics').then(function (body) {
      clear(analyticsTable);
      var rows = (body.groups || []).map(function (g) {
        return {
          world: g.world, task: g.task, model: g.model, runs: g.runs, successes: g.successes,
          'success rate': g.successRate, 'cost usd': usd(g.costUsd),
          'cost per success': g.costPerSuccessUsd === null ? '-' : usd(g.costPerSuccessUsd),
          'mean turns': g.meanTurns,
          'failure causes': Object.keys(g.failures).map(function (k) { return k + ' x' + g.failures[k]; }).join(', '),
          provenance: 'engine ' + g.engineCommits.map(function (c) { return c.slice(0, 8); }).join(', ') + '; world ' + g.worldVersions.map(function (v) { return v.slice(0, 8); }).join(', ')
        };
      });
      if (rows.length > 0) analyticsTable.appendChild(grid(['world', 'task', 'model', 'runs', 'successes', 'success rate', 'cost usd', 'cost per success', 'mean turns', 'failure causes', 'provenance'], rows));
      if ((body.unreadable || []).length > 0) analyticsTable.appendChild(el('p', 'unreadable episode lines: ' + body.unreadable.join(', ')));
      analyticsMeta.textContent = ANALYTICS_META;
    }, function (e) { analyticsMeta.textContent = 'unreachable: ' + e; });
  }
  function refreshEpisodes() {
    refreshAnalytics();
    episodesMeta.textContent = 'loading…';
    return getJson('/api/episodes').then(function (body) {
      clear(episodesTable);
      var list = body.episodes || [];
      episodesMeta.textContent = list.length + ' episode run(s) under eval/episodes';
      var rows = list.map(function (r) {
        var b = el('button', 'show');
        b.type = 'button';
        b.addEventListener('click', function () { watching = r.runId; showEpisode(r.runId); });
        return { run: r.runId, world: r.world, task: r.task, stop: r.running ? 'running' : r.stop, score: r.score === null ? '-' : r.score, 'cost usd': r.costUsd === null ? '-' : usd(r.costUsd), '': b };
      });
      if (rows.length > 0) episodesTable.appendChild(grid(['run', 'world', 'task', 'stop', 'score', 'cost usd', ''], rows));
    }, function (e) { episodesMeta.textContent = 'unreachable: ' + e; });
  }
  byId('play-run').addEventListener('click', function () {
    var body = { world: playWorld.value, task: playTask.value, agent: byId('play-agent').value };
    var budget = Number(byId('play-budget').value);
    var turns = Number(byId('play-turns').value);
    if (budget > 0) body.budgetUsd = budget;
    if (turns > 0) body.maxTurns = Math.floor(turns);
    post('/api/episodes', body).then(function (r) {
      if (r.error) { playMeta.textContent = r.error.code + ': ' + r.error.message; return; }
      playMeta.textContent = 'started ' + r.runId;
      watching = r.runId;
      refreshEpisodes();
      showEpisode(r.runId);
    }, function (e) { playMeta.textContent = 'unreachable: ' + e; });
  });
  // ---- Explorer: one world's definition, its running instance, and the API console ---
  var explorerWorld = byId('explorer-world');
  var explorerMeta = byId('explorer-meta');
  var explorerBody = byId('explorer-body');
  var consoleMeta = byId('console-meta');
  var consoleMethod = byId('console-method');
  var consolePath = byId('console-path');
  var consoleBody = byId('console-body');
  var consoleResult = byId('console-result');

  function fillExplorerWorlds() {
    return getJson('/api/worlds').then(function (body) {
      var keep = explorerWorld.value;
      clear(explorerWorld);
      (body.worlds || []).forEach(function (w) {
        var opt = el('option', w.name);
        opt.value = w.name;
        explorerWorld.appendChild(opt);
      });
      if (keep !== '') explorerWorld.value = keep;
    }, function (e) { explorerMeta.textContent = 'unreachable: ' + e; });
  }
  function fieldText(f) { return f.name + ': ' + (f.ref === null ? f.type : 'ref to ' + f.ref); }
  function consoleButton(label, method, target, records) {
    var b = el('button', label);
    b.type = 'button';
    b.addEventListener('click', function () {
      consoleMethod.value = method;
      consolePath.value = target;
      consoleBody.value = '';
      if (records) send(true);
    });
    return b;
  }
  function explore() {
    var name = explorerWorld.value;
    if (name === '') return;
    explorerMeta.textContent = 'loading…';
    setHash(name, 'explorer');
    getJson('/api/worlds/' + encodeURIComponent(name) + '/explorer').then(function (x) {
      clear(explorerBody);
      if (x.error !== undefined) { explorerMeta.textContent = x.error.code + ': ' + x.error.message; return; }
      explorerMeta.textContent = 'definition ' + x.wid + ', clock starts ' + x.clockStart;
      explorerBody.appendChild(el('p', x.description + (x.resembles === '' ? '' : ' Resembles ' + x.resembles + '.')));
      explorerBody.appendChild(el('h3', 'entities (' + x.entities.length + ')'));
      explorerBody.appendChild(grid(['entity', 'id prefix', 'fields', 'refers to', 'referenced by'], x.entities.map(function (e) {
        return { entity: e.name, 'id prefix': e.idPrefix, fields: e.fields.map(fieldText).join(', '), 'refers to': e.refersTo.join(', ') || 'none', 'referenced by': e.referencedBy.join(', ') || 'none' };
      })));
      explorerBody.appendChild(el('h3', 'routes and actions (' + x.routes.length + ')'));
      explorerBody.appendChild(grid(['method', 'path', 'kind', 'about', 'console'], x.routes.map(function (r) {
        var buttons = document.createElement('span');
        buttons.appendChild(consoleButton('try', r.method, r.path, false));
        if (r.kind === 'list') buttons.appendChild(consoleButton('records', 'GET', r.path, true));
        return { method: r.method, path: r.path, kind: r.kind, about: r.entity !== null ? r.entity : (r.description || r.input.map(fieldText).join(', ')), console: buttons };
      })));
      if (x.jobs.length > 0) {
        explorerBody.appendChild(el('h3', 'jobs (' + x.jobs.length + ')'));
        explorerBody.appendChild(grid(['job', 'every', 'about'], x.jobs.map(function (j) { return { job: j.name, every: j.every, about: j.description }; })));
      }
      explorerBody.appendChild(el('h3', 'tasks (' + x.tasks.length + '), as an agent is told them'));
      explorerBody.appendChild(grid(['task', 'difficulty', 'instruction', 'tid'], x.tasks.map(function (t) { return { task: t.id, difficulty: t.difficulty, instruction: t.instruction, tid: t.tid }; })));
    }, function (e) { explorerMeta.textContent = 'unreachable: ' + e; });
  }
  /** The rows of a list answer: the body itself when it is an array, else its first array property. */
  function rowsOf(value) {
    if (Array.isArray(value)) return value;
    if (value === null || typeof value !== 'object') return null;
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) if (Array.isArray(value[keys[i]])) return value[keys[i]];
    return null;
  }
  function send(records) {
    var name = explorerWorld.value;
    clear(consoleResult);
    getJson('/api/services').then(function (body) {
      var svc = serviceFor(name, body.services || []);
      if (svc === null) { consoleMeta.textContent = name + ' is not running: serve it in Worlds, then send'; return null; }
      consoleMeta.textContent = 'running instance ' + svc.id + ' on world port ' + svc.worldPort + ' since ' + svc.startedAt;
      var req = { method: consoleMethod.value, path: consolePath.value };
      if (consoleBody.value.trim() !== '') {
        try { req.body = JSON.parse(consoleBody.value); } catch (e) { consoleResult.appendChild(el('p', 'the body is not JSON: ' + e.message)); return null; }
      }
      return post('/api/services/' + encodeURIComponent(svc.id) + '/call', req).then(function (r) {
        if (r.error !== undefined) { consoleResult.appendChild(el('p', r.error.code + ': ' + r.error.message)); return; }
        consoleResult.appendChild(el('p', 'HTTP ' + r.status + ' from ' + r.world + ' in ' + r.ms + ' ms: ' + r.request.method + ' ' + r.request.path + (r.truncated ? ' (cut at 1 MiB)' : '')));
        var parsed = null;
        try { parsed = JSON.parse(r.body); } catch (e) { parsed = null; }
        var rows = records && parsed !== null ? rowsOf(parsed) : null;
        if (rows !== null && rows.length > 0 && rows[0] !== null && typeof rows[0] === 'object') {
          consoleResult.appendChild(grid(Object.keys(rows[0]).slice(0, 8), rows));
        }
        consoleResult.appendChild(el('pre', parsed === null ? r.body : JSON.stringify(parsed, null, 2)));
      });
    }).catch(function (e) { consoleMeta.textContent = 'unreachable: ' + e; });
  }
  byId('explorer-load').addEventListener('click', explore);
  byId('console-form').addEventListener('submit', function (ev) { ev.preventDefault(); send(false); });

  // ---- Resume: once sign-in and the worlds lists have resolved, the hash restores its view ----------
  function hasOption(select, name) {
    for (var i = 0; i < select.options.length; i++) if (select.options[i].value === name) return true;
    return false;
  }
  function restoreFromHash() {
    var params = new URLSearchParams(location.hash.slice(1));
    var name = params.get('world');
    var view = params.get('view');
    if (name === null || name === '' || !hasOption(explorerWorld, name)) return;
    if (view === 'explorer') {
      explorerWorld.value = name;
      byId('sec-explorer').scrollIntoView();
      explore();
    } else if (view === 'report') {
      openReport(name);
      byId('sec-worlds').scrollIntoView();
    } else if (view === 'plan') {
      openPlan(name);
      byId('sec-worlds').scrollIntoView();
    } else if (view === 'play' && hasOption(playWorld, name)) {
      playWorld.value = name;
      loadTasks();
      byId('sec-playground').scrollIntoView();
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('nav a'), function (a) {
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      byId(a.getAttribute('href').slice(1)).scrollIntoView();
    });
  });
  var worldsReady = Promise.all([refreshWorlds(), fillExplorerWorlds(), loadPlayWorlds()]);
  refreshRuns();
  refreshEval();
  refreshEpisodes();
  refreshSpend();
  Promise.all([signedIn, worldsReady]).then(function (done) {
    if (!done[0]) return;
    restoreFromHash();
    window.addEventListener('hashchange', restoreFromHash);
  });
}());
</script>
</body>
</html>
`;
}
