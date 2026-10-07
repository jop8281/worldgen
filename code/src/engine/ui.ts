/**
 * The operator console: one self-contained HTML page served at `GET /` on the admin port.
 *
 * Invariants:
 * - Pure. The page is one string built from the world name and the world port number alone, so
 *   no private task material (graders, solutions, decoys) can reach it. Everything else it
 *   shows it fetches at runtime from the admin routes, same-origin and relative.
 * - Fully offline: inline CSS, vanilla JS, no framework, no build step, and no external request.
 *   The document contains no absolute URL at all, so nothing it loads can leave the admin port
 *   it was served from. The world port number is displayed, never fetched.
 * - Rendered strings go through textContent, never innerHTML. The build-time values (the world
 *   name) are HTML-escaped here, so a name cannot break out of the markup.
 */
const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

/**
 * The console page for one served world: State (tables, refresh, auto-refresh), Log (the latest
 * 50 calls), Clock (advance the engine clock), Reset (back to the seed) and the API catalog
 * (rendered from the admin OpenAPI mirror, never executed).
 */
export function consolePage(worldName: string, worldPort: number): string {
  const name = escapeHtml(worldName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} console</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 1rem 1.25rem 3rem; }
h1 { font-size: 1.3rem; margin: 0; }
h2 { border-bottom: 1px solid #8884; font-size: 1.05rem; margin: 1.6rem 0 0.4rem; padding-bottom: 0.2rem; }
h3 { font-size: 0.95rem; margin: 1rem 0 0.3rem; }
.meta { color: #888; font-size: 0.85rem; margin-left: 0.75rem; }
table { border-collapse: collapse; margin: 0.3rem 0 1rem; max-width: 100%; }
th, td { border: 1px solid #8884; padding: 0.15rem 0.5rem; text-align: left; vertical-align: top; }
th { background: #8881; font-weight: 600; }
td { font-family: ui-monospace, monospace; font-size: 0.85rem; max-width: 32rem; overflow-wrap: anywhere; }
button { cursor: pointer; }
input { font: inherit; padding: 0.15rem 0.4rem; width: 5rem; }
.danger { background: #b00; border: 0; color: #fff; padding: 0.2rem 0.6rem; }
</style>
</head>
<body>
<header>
<h1>${name}</h1>
<p class="meta">operator console, admin port only; world port ${worldPort} (displayed, never fetched)</p>
</header>
<section>
<h2>State</h2>
<p>
<button id="state-refresh" type="button">refresh</button>
<label><input id="state-auto" type="checkbox"> auto-refresh every 2s</label>
<span id="state-meta" class="meta"></span>
</p>
<div id="state-tables"></div>
</section>
<section>
<h2>Log<span id="log-meta" class="meta"></span></h2>
<div id="log-table"></div>
</section>
<section>
<h2>Clock and reset</h2>
<p>
<input id="advance" value="4h">
<button id="clock-advance" type="button">advance clock</button>
<button id="world-reset" type="button" class="danger">reset world</button>
<span id="control-msg" class="meta"></span>
</p>
</section>
<section>
<h2>API catalog<span class="meta">render only; the console never sends world requests</span></h2>
<div id="api-groups"></div>
</section>
<script>
(function () {
  'use strict';
  var byId = function (id) { return document.getElementById(id); };
  var stateTables = byId('state-tables');
  var stateMeta = byId('state-meta');
  var stateAuto = byId('state-auto');
  var logTable = byId('log-table');
  var logMeta = byId('log-meta');
  var apiGroups = byId('api-groups');
  var controlMsg = byId('control-msg');
  var advanceInput = byId('advance');
  var stateTimer = null;

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function getJson(path) { return fetch(path).then(function (r) { return r.json(); }); }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }
  function cell(value) {
    if (value === null || value === undefined) return 'null';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  /** A table for rows of plain objects: one column per name in cols. */
  function grid(cols, rows) {
    var table = document.createElement('table');
    var head = document.createElement('tr');
    for (var c = 0; c < cols.length; c++) head.appendChild(el('th', cols[c]));
    table.appendChild(head);
    for (var r = 0; r < rows.length; r++) {
      var tr = document.createElement('tr');
      for (var k = 0; k < cols.length; k++) tr.appendChild(el('td', cell(rows[r][cols[k]])));
      table.appendChild(tr);
    }
    return table;
  }

  // ---- State: every table with its row count and a few columns -----------------
  function pairs(map) {
    var out = [];
    var keys = Object.keys(map || {});
    for (var i = 0; i < keys.length; i++) out.push(keys[i] + ' ' + map[keys[i]]);
    return out.join(', ') || 'none';
  }
  function renderState(dump) {
    stateMeta.textContent = 'now ' + dump.now + ', hash ' + dump.hash + ', counters ' + pairs(dump.counters);
    clear(stateTables);
    var names = Object.keys(dump.tables || {});
    if (names.length === 0) stateTables.appendChild(el('p', 'no tables'));
    for (var i = 0; i < names.length; i++) {
      var rows = dump.tables[names[i]] || [];
      stateTables.appendChild(el('h3', names[i] + ' (' + rows.length + ' rows)'));
      if (rows.length === 0) { stateTables.appendChild(el('p', 'empty')); continue; }
      stateTables.appendChild(grid(Object.keys(rows[0]).slice(0, 4), rows));
    }
  }
  function refreshState() {
    return getJson('/_world/state').then(renderState, function (e) { stateMeta.textContent = 'unreachable: ' + e; });
  }
  byId('state-refresh').addEventListener('click', refreshState);
  stateAuto.addEventListener('change', function () {
    if (stateTimer !== null) { window.clearInterval(stateTimer); stateTimer = null; }
    if (stateAuto.checked) { refreshState(); stateTimer = window.setInterval(refreshState, 2000); }
  });

  // ---- Log: the latest 50 calls ------------------------------------------------
  function writeSummary(writes) {
    if (writes.length === 0) return 'no writes';
    var parts = [];
    for (var i = 0; i < writes.length; i++) {
      parts.push(writes[i].entity + '/' + writes[i].id + ' ' + writes[i].op + ' (' + writes[i].fields.join(', ') + ')');
    }
    return writes.length + (writes.length === 1 ? ' write: ' : ' writes: ') + parts.join('; ');
  }
  function refreshLog() {
    return getJson('/_world/log').then(function (body) {
      var calls = body.calls || [];
      var latest = calls.slice(-50);
      logMeta.textContent = calls.length + ' call(s), showing the latest ' + latest.length;
      clear(logTable);
      if (latest.length === 0) { logTable.appendChild(el('p', 'no calls')); return; }
      logTable.appendChild(grid(['seq', 'at', 'request', 'status', 'writes'], latest.map(function (call) {
        return {
          seq: call.seq,
          at: call.at,
          request: call.req.method + ' ' + call.req.path + (call.routeId === null || call.routeId === undefined ? '' : ' (' + call.routeId + ')'),
          status: call.res.status,
          writes: writeSummary(call.writes || [])
        };
      })));
    }, function (e) { logMeta.textContent = 'unreachable: ' + e; });
  }

  // ---- Clock and reset -----------------------------------------------------------
  function showControl(body) {
    if (body && body.error) controlMsg.textContent = 'error ' + body.error.code + ': ' + body.error.message;
    else if (body && body.now) {
      controlMsg.textContent = 'ok, now ' + body.now
        + (body.jobsFired ? ', jobs fired ' + body.jobsFired.length + ', failed ' + body.jobsFailed.length : '');
    } else controlMsg.textContent = 'ok ' + JSON.stringify(body);
    refreshState();
    refreshLog();
  }
  byId('clock-advance').addEventListener('click', function () {
    post('/_world/clock', { advance: advanceInput.value }).then(showControl, function (e) { controlMsg.textContent = 'unreachable: ' + e; });
  });
  byId('world-reset').addEventListener('click', function () {
    if (!window.confirm('Reset the world to its seed and clear the log?')) return;
    post('/_world/reset', {}).then(showControl, function (e) { controlMsg.textContent = 'unreachable: ' + e; });
  });

  // ---- API catalog: rendered from the admin OpenAPI mirror, never executed ------
  function refreshApi() {
    return getJson('/_world/openapi').then(function (doc) {
      clear(apiGroups);
      var groups = {};
      var paths = Object.keys(doc.paths || {});
      for (var i = 0; i < paths.length; i++) {
        var item = doc.paths[paths[i]] || {};
        var methods = Object.keys(item);
        for (var m = 0; m < methods.length; m++) {
          var op = item[methods[m]];
          if (!op || !op.operationId) continue;
          var group = (op.tags && op.tags.length > 0) ? op.tags[0] : 'other';
          groups[group] = groups[group] || [];
          groups[group].push({
            method: methods[m].toUpperCase(),
            path: paths[i],
            id: op.operationId,
            params: (op.parameters || []).map(function (p) { return p.name; }).join(', ')
          });
        }
      }
      var names = Object.keys(groups);
      if (names.length === 0) apiGroups.appendChild(el('p', 'no operations'));
      for (var g = 0; g < names.length; g++) {
        apiGroups.appendChild(el('h3', names[g] + ' (' + groups[names[g]].length + ')'));
        apiGroups.appendChild(grid(['method', 'path', 'route id', 'params'], groups[names[g]]));
      }
    }, function (e) { apiGroups.appendChild(el('p', 'unreachable: ' + e)); });
  }

  refreshState();
  refreshLog();
  refreshApi();
}());
</script>
</body>
</html>
`;
}
