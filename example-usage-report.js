#!/usr/bin/env node
/**
 * apigee-usage-report.js
 * ---------------------------------------------------------------------------
 * Generates a self-contained HTML report of API proxy traffic for every
 * environment of an Apigee organization, reading through the local
 * management proxy at http://localhost:8080.
 *
 * Dependency-free. Requires Node 18+ (uses the built-in fetch).
 * READ-ONLY: sends GET requests only. Never creates, updates or deletes
 * anything in Apigee.
 *
 * QUICK START
 *   node apigee-usage-report.js
 *   node apigee-usage-report.js --days 30
 *   node apigee-usage-report.js --month last
 *   node apigee-usage-report.js --from 11/01/2026 --to 11/30/2026
 *   node apigee-usage-report.js --org gcp-pttep-th-it-apimgmt-dev --out dev.html
 *
 * RUN IT MONTHLY (no dates to edit)
 *   --month last   -> the whole previous calendar month
 *   --days 30      -> a rolling 30-day window ending today
 *   Add it to Windows Task Scheduler and let it email/write the file.
 *
 * OPTIONS (CLI flag / env var)
 *   --base URL      BASE_URL   proxy address     (default http://localhost:8080)
 *   --org NAME      ORG        organization      (default gcp-pttep-th-it-apimgmt)
 *   --days N        DAYS       rolling window    (default 7)
 *   --month last    MONTH      whole previous calendar month
 *   --from DATE     FROM       window start, MM/DD/YYYY
 *   --to DATE       TO         window end,   MM/DD/YYYY
 *   --top N         TOP        rows per env      (default 10)
 *   --out FILE      OUT        HTML output path
 *   --json FILE                also dump the raw data as JSON
 *   --quiet         QUIET      suppress the console table
 *   --help                     show this help
 *
 * WHY THE apiproxy DIMENSION
 *   Apigee also exposes a dimension called "proxy", but it is a coarse
 *   grouping, not the proxy name: on this org "proxy eq 'default'" expands to
 *   27 distinct proxies. This script queries "apiproxy" and then verifies
 *   every returned name against GET /apis, so a wrong dimension fails loudly
 *   instead of producing a plausible but wrong report.
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --------------------------------------------------------------------------
// configuration
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // -h and a bare "help" open the manual too
    if (a === '-h' || a === 'help') { opts.help = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'help' || key === 'quiet') { opts[key] = true; continue; }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) { opts[key] = true; continue; }
    opts[key] = val;
    i++;
  }
  return opts;
}

const argv = parseArgs(process.argv.slice(2));

const HELP_ALIASES = new Set(['--help', '-h', 'help']);
const KNOWN_OPTIONS = new Set(['base', 'org', 'days', 'month', 'from', 'to', 'top', 'out', 'json', 'quiet', 'help']);

const MANUAL = `
apigee-usage-report.js - API usage report for an Apigee organization

SYNOPSIS
  node apigee-usage-report.js [options]

DESCRIPTION
  Reads Apigee analytics through the local management proxy and writes a
  self-contained HTML report of per-environment API proxy traffic.

  Read-only. Sends GET requests only; never creates, modifies or deletes
  anything in Apigee. Requires Node 18+ (built-in fetch), no dependencies.

  Run it with no options for a 7-day report of the default organization.
  Use --month last for a fixed monthly report with no dates to edit.

TIME WINDOW (choose one)
  --days N          Rolling window: N days ending today.        [default 7]
  --month last      The whole previous calendar month.
  --from D --to D   Explicit range, MM/DD/YYYY, both required.

  All three are computed at run time, so the same command keeps working.
  A window that ends today is partial; --month last never is.

OPTIONS
  -h, --help, help  Show this manual.
  --base URL        Proxy address.                 [http://localhost:8080]
  --org NAME        Apigee organization.           [gcp-pttep-th-it-apimgmt]
  --days N          Rolling window length in days.              [7]
  --month last      Report the previous calendar month.
  --from MM/DD/YYYY Window start (requires --to).
  --to MM/DD/YYYY   Window end (requires --from).
  --top N           Proxy rows shown per environment.          [10]
  --out FILE        HTML output path.   [apigee-usage-<org>-<today>.html]
  --json FILE       Also write the raw data as JSON.
  --quiet           Suppress the console table; print only the paths.

  Every option also reads an environment variable of the same name,
  upper-case: BASE_URL, ORG, DAYS, MONTH, FROM, TO, TOP, OUT, QUIET.
  A command-line flag wins over the environment variable.

EXAMPLES
  Show this manual
    node apigee-usage-report.js --help

  Default: last 7 days, production org, report beside the script
    node apigee-usage-report.js

  Monthly report for the previous calendar month
    node apigee-usage-report.js --month last

  Rolling 30-day report, top 20 proxies, keep the raw data
    node apigee-usage-report.js --days 30 --top 20 --json usage.json

  An explicit range
    node apigee-usage-report.js --from 11/01/2026 --to 11/30/2026

  A different organization and output file
    node apigee-usage-report.js --org gcp-pttep-th-it-apimgmt-dev --out dev.html

  Silent mode for a scheduled task
    node apigee-usage-report.js --month last --quiet

OUTPUT
  Console   One line per environment: total calls, active proxies, top proxy,
            then an org total and the integrity verdict.
  HTML      Totals by environment, top proxies across the whole organization,
            per-environment detail with collapsed long tail, and a
            methodology section. Self-contained and print-friendly.
  JSON      Optional, with --json: same numbers as machine-readable data.

EXIT CODES
  0   Success.
  1   Usage problem, proxy unreachable, or organization not readable.
  2   Report written, but the integrity check failed (see below).

  Safe to gate a scheduled task or CI job on the exit code.

HOW IT WORKS
  1. GET /v1/organizations/{org}/environments   discover environments
  2. GET /v1/organizations/{org}/apis           authoritative proxy list
  3. GET .../environments/{env}/stats/apiproxy  traffic per proxy per env
  4. Compare every analytics name against the list from step 2.
  5. Write the HTML report.

  Step 4 is the integrity check. Analytics can return names that do not
  exist in your organization; if that happens the report says so and exits
  2 rather than presenting a plausible but wrong result.

WHY "apiproxy" AND NOT "proxy"
  Apigee also exposes a dimension called "proxy", and it returns names that
  look real. It is not the proxy name: grouping "proxy eq 'default'" expands
  to 27 distinct proxies. Totals are identical either way, so the error is
  invisible unless names are checked - hence step 4.

TROUBLESHOOTING
  fetch failed (ECONNREFUSED)
      The proxy is not running. Start it, or point --base at the right port.

  403 PERMISSION_DENIED
      The organization name is wrong, or the proxy's credentials cannot read
      it. Apigee returns 403 rather than 404 for an unknown org on purpose.

  integrity: FAILED
      Analytics returned names missing from /apis. The report is written but
      suspect; exit code is 2. Do not publish it as-is.

  An environment reports ERROR 400
      That environment's analytics schema lacks the metric. Other
      environments still report normally.

  Every environment shows no traffic
      Check the window: analytics is eventually consistent and can lag
      minutes, and an empty range or a future date returns nothing.

  Numbers shift between runs
      Expected. BigQuery-backed analytics is eventually consistent; the same
      window minutes apart moves by a few dozen calls.
`;

if (argv.help || process.argv.slice(2).some(a => HELP_ALIASES.has(a))) {
  console.log(MANUAL.replace(/^\n/, ''));
  process.exit(0);
}

// A misspelled flag must not silently fall back to a default window.
const unknownFlags = Object.keys(argv).filter(k => !KNOWN_OPTIONS.has(k));
if (unknownFlags.length) {
  console.error(`\n  ERROR unknown option${unknownFlags.length > 1 ? 's' : ''}: ${unknownFlags.map(f => '--' + f).join(', ')}`);
  console.error(`  Run "node ${path.basename(__filename)} --help" for the manual.\n`);
  process.exit(1);
}

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    console.error(`\n  ERROR --${name} must be a positive number, got "${value}".`);
    console.error(`  Run "node ${path.basename(__filename)} --help" for the manual.\n`);
    process.exit(1);
  }
  return Math.floor(n);
}

const BASE_URL = argv.base || process.env.BASE_URL || 'http://localhost:8080';
const ORG = argv.org || process.env.ORG || 'gcp-pttep-th-it-apimgmt';
const DIM = 'apiproxy';
const TIME_UNIT_METRIC = 'sum(message_count)';
const TOP_N = positiveInt('top', argv.top || process.env.TOP || 10);
const QUIET = Boolean(argv.quiet || process.env.QUIET);
const OUT = argv.out || process.env.OUT || `apigee-usage-${ORG}-${todayStamp()}.html`;
const JSON_OUT = argv.json || null;

// --------------------------------------------------------------------------
// date window
// --------------------------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }

/** MM/DD/YYYY HH:mm — the format the /stats endpoint expects. */
function statsDate(d) {
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** YYYY-MM-DD — for filenames. */
function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseUserDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s).trim());
  if (!m) throw new Error(`bad date "${s}" - expected MM/DD/YYYY`);
  const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  if (Number.isNaN(d.getTime())) throw new Error(`bad date "${s}"`);
  return d;
}

function resolveWindow() {
  // explicit start/end wins
  if (argv.from || argv.to) {
    if (!argv.from || !argv.to) throw new Error('--from and --to must be given together');
    const start = parseUserDate(argv.from);
    const end = parseUserDate(argv.to);
    if (end < start) throw new Error('--to is before --from');
    return { start, end, label: `${argv.from} - ${argv.to}` };
  }

  // whole previous calendar month
  const monthMode = argv.month || process.env.MONTH;
  if (monthMode) {
    if (monthMode !== 'last') throw new Error('--month only supports "last"');
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 0);
    return { start, end, label: `${start.toLocaleString('en-US', { month: 'long', year: 'numeric' })} (previous calendar month)` };
  }

  // rolling window ending today
  const days = positiveInt('days', argv.days || process.env.DAYS || 7);
  const end = new Date();
  end.setHours(23, 59, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return { start, end, label: `last ${days} day${days === 1 ? '' : 's'}` };
}

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------

async function getJson(apiPath, { retries = 3, timeoutMs = 90000 } = {}) {
  const url = BASE_URL + apiPath;
  let lastErr = '';
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        // no keep-alive: lets the event loop drain cleanly instead of tripping
        // a libuv assertion when the process exits with sockets still closing
        headers: { connection: 'close' },
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
      if (res.ok) return body;
      // client errors are final; server errors and 429 are worth retrying
      if (res.status < 500 && res.status !== 429) {
        const err = new Error(`${res.status} ${JSON.stringify(body).slice(0, 200)}`);
        err.final = true;
        err.status = res.status;
        throw err;
      }
      lastErr = `${res.status} ${JSON.stringify(body).slice(0, 120)}`;
    } catch (e) {
      if (e.final) throw e;
      const cause = e.cause?.code || e.cause?.message;
      lastErr = e.name === 'TimeoutError' || e.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : (cause ? `${e.message} (${cause})` : e.message);
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 1200 * attempt));
  }
  throw new Error(lastErr);
}

/** Pull (name, calls) rows out of a /stats response. */
function readStats(body) {
  const envBlock = (body.environments || [])[0];
  const rows = [];
  for (const d of envBlock?.dimensions || []) {
    const v = d.metrics?.[0]?.values?.[0];
    const num = typeof v === 'string' ? Number(v) : Number(v?.value ?? 0);
    const name = d.name ?? (d.individualNames || []).join('+');
    if (!name || name === 'null') continue;
    rows.push({ name, calls: Number.isFinite(num) ? num : 0 });
  }
  rows.sort((a, b) => b.calls - a.calls);
  return rows;
}

// --------------------------------------------------------------------------
// collection
// --------------------------------------------------------------------------

async function collect() {
  const win = resolveWindow();
  const range = `${statsDate(win.start)}~${statsDate(win.end)}`;

  // 1. which environments exist?
  let environments;
  try {
    environments = await getJson(`/v1/organizations/${ORG}/environments`);
  } catch (e) {
    if (e.status === 403) {
      throw new Error(`403 PERMISSION_DENIED for organization "${ORG}". ` +
        `Check the org name and that the proxy's credentials can read it.`);
    }
    throw new Error(`cannot list environments for "${ORG}": ${e.message}`);
  }
  if (!Array.isArray(environments) || environments.length === 0) {
    throw new Error(`organization "${ORG}" returned no environments`);
  }

  // 2. the authoritative proxy list, used to validate every analytics name
  const apisBody = await getJson(`/v1/organizations/${ORG}/apis`);
  const knownProxies = new Set(
    (apisBody.proxies || []).map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean)
  );

  // 3. per-environment stats
  const results = [];
  for (const env of environments) {
    const qs = new URLSearchParams({ select: TIME_UNIT_METRIC, timeRange: range });
    try {
      const body = await getJson(`/v1/organizations/${ORG}/environments/${env}/stats/${DIM}?${qs}`);
      const rows = readStats(body);
      const total = rows.reduce((s, r) => s + r.calls, 0);
      results.push({ env, ok: true, rows, total });
    } catch (e) {
      // A 400 usually means this org's analytics schema lacks a metric.
      results.push({ env, ok: false, rows: [], total: 0, error: e.message });
    }
  }

  results.sort((a, b) => b.total - a.total);

  const unknown = [...new Set(
    results.flatMap(r => r.rows.map(x => x.name)).filter(n => !knownProxies.has(n))
  )];

  return { win, range, environments, knownProxies, results, unknown };
}

// --------------------------------------------------------------------------
// report
// --------------------------------------------------------------------------

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => v.toLocaleString('en-US');
const share = (v, t) => (t ? ((v / t) * 100).toFixed(1) : '0.0');

function bar(value, total) {
  const w = Math.max((value / total) * 100, 0.35);
  return `<span class="bar"><span style="width:${w.toFixed(2)}%"></span></span>`;
}

function buildHtml(data) {
  const { win, range, knownProxies, results, unknown } = data;
  const good = results.filter(r => r.ok);
  const orgTotal = good.reduce((s, r) => s + r.total, 0);
  const activePairs = good.reduce((s, r) => s + r.rows.length, 0);
  const distinct = new Set(good.flatMap(r => r.rows.map(x => x.name)));
  const generated = new Date().toLocaleString('en-US');

  const totalsRows = good.map(r => `<tr>
      <td><a href="#env-${esc(r.env)}"><code>${esc(r.env)}</code></a></td>
      <td class="num">${r.rows.length}</td>
      <td class="num"><strong>${num(r.total)}</strong></td>
      <td class="num">${share(r.total, orgTotal)}%</td>
      <td class="bars">${bar(r.total, orgTotal)}</td>
      <td class="num">${r.rows.length ? share(r.rows[0].calls, r.total) + '%' : '&mdash;'}</td>
    </tr>`).join('\n');

  const failed = results.filter(r => !r.ok);
  const failedBlock = failed.length ? `
<div class="callout bad">
  <p><strong>${failed.length} environment(s) returned no data.</strong></p>
  <ul>${failed.map(r => `<li><code>${esc(r.env)}</code> &mdash; ${esc(r.error)}</li>`).join('')}</ul>
</div>` : '';

  // org-wide rollup: same proxy active in several environments
  const rollup = new Map();
  for (const r of good) {
    for (const x of r.rows) {
      const cur = rollup.get(x.name) || { name: x.name, calls: 0, envs: new Set() };
      cur.calls += x.calls;
      cur.envs.add(r.env);
      rollup.set(x.name, cur);
    }
  }
  const rollupTop = [...rollup.values()].sort((a, b) => b.calls - a.calls).slice(0, 15);
  const rollupRows = rollupTop.map((p, i) => `<tr>
      <td class="num muted2">${i + 1}</td>
      <td><code>${esc(p.name)}</code></td>
      <td class="num">${num(p.calls)}</td>
      <td class="num">${share(p.calls, orgTotal)}%</td>
      <td class="bars">${bar(p.calls, orgTotal)}</td>
      <td class="num">${p.envs.size}</td>
    </tr>`).join('\n');

  const envSections = good.map(r => {
    const top = r.rows.slice(0, TOP_N);
    const rest = r.rows.slice(TOP_N);
    const rows = top.map((p, i) => `<tr>
        <td class="num muted2">${i + 1}</td>
        <td><code>${esc(p.name)}</code></td>
        <td class="num">${num(p.calls)}</td>
        <td class="num">${share(p.calls, r.total)}%</td>
        <td class="bars">${bar(p.calls, r.total)}</td>
      </tr>`).join('\n');
    const restBlock = rest.length ? `
    <details>
      <summary>Show remaining ${rest.length} prox${rest.length === 1 ? 'y' : 'ies'}</summary>
      <table class="mini"><tbody>
      ${rest.map(p => `<tr><td><code>${esc(p.name)}</code></td><td class="num">${num(p.calls)}</td><td class="num">${share(p.calls, r.total)}%</td></tr>`).join('\n      ')}
      </tbody></table>
    </details>` : '';
    return `
<h3 id="env-${esc(r.env)}"><code>${esc(r.env)}</code></h3>
<div class="metricrow">
  <div><span class="lbl">Total calls</span><span class="val">${num(r.total)}</span></div>
  <div><span class="lbl">Share of org</span><span class="val">${share(r.total, orgTotal)}%</span></div>
  <div><span class="lbl">Active proxies</span><span class="val">${r.rows.length}</span></div>
  <div><span class="lbl">Top proxy</span><span class="val"><code>${esc(r.rows[0]?.name || '-')}</code>${r.rows.length ? ' ' + share(r.rows[0].calls, r.total) + '%' : ''}</span></div>
</div>
<table>
  <thead><tr><th class="num">#</th><th>API proxy</th><th class="num">Calls</th><th class="num">Share</th><th class="bars">Distribution</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>${restBlock}`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apigee API Usage - ${esc(ORG)} - ${esc(win.label)}</title>
<style>
  :root { --bg:#0f1216; --panel:#161b22; --panel-2:#1c232c; --border:#2a3340; --text:#d8dee9;
          --muted:#8b98a8; --accent:#4da3ff; --warn:#d29922; --block:#f85149; --code-bg:#0b0e12; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:15px/1.65 "Segoe UI", system-ui, -apple-system, sans-serif; padding:40px 20px 80px; }
  .wrap { max-width:1000px; margin:0 auto; }
  header { border-bottom:1px solid var(--border); padding-bottom:22px; margin-bottom:28px; }
  h1 { font-size:28px; margin:0 0 8px; letter-spacing:-0.3px; }
  .sub { color:var(--muted); font-size:14px; margin:0; }
  .sub code { color:var(--accent); }
  .asof { display:inline-block; margin-top:14px; padding:3px 12px; border-radius:20px;
          background:rgba(77,163,255,0.12); border:1px solid rgba(77,163,255,0.35);
          color:var(--accent); font-size:12px; font-weight:600; letter-spacing:0.3px; }
  h2 { font-size:19px; margin:42px 0 14px; padding-bottom:8px;
       border-bottom:1px solid var(--border); letter-spacing:-0.2px; }
  h3 { font-size:16px; margin:34px 0 12px; color:#eef2f7; }
  h3 code { font-size:16px; background:none; color:#eef2f7; padding:0; }
  p { margin:10px 0; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  code { font-family:"Cascadia Code","Fira Code",Consolas,monospace; font-size:0.88em;
         background:var(--panel-2); padding:2px 6px; border-radius:4px; color:#a5d6ff; }
  table { width:100%; border-collapse:collapse; margin:14px 0; font-size:13.5px;
          background:var(--panel); border-radius:8px; overflow:hidden; }
  th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--border); vertical-align:middle; }
  th { background:var(--panel-2); font-weight:600; font-size:12px; color:#b9c6d6;
       text-transform:uppercase; letter-spacing:0.4px; }
  tr:last-child td { border-bottom:none; }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.muted2 { color:var(--muted); }
  td.bars,th.bars { width:20%; }
  .bar { display:block; height:8px; background:var(--panel-2); border-radius:4px; overflow:hidden; }
  .bar > span { display:block; height:100%; border-radius:4px;
                background:linear-gradient(90deg,#1f6feb,var(--accent)); }
  .cards { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin:18px 0; }
  @media (max-width:760px) { .cards,.metricrow { grid-template-columns:1fr 1fr; } }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px 18px; }
  .card .k { font-size:11.5px; text-transform:uppercase; letter-spacing:0.5px; color:var(--muted); }
  .card .v { font-size:26px; font-weight:600; letter-spacing:-0.5px; margin-top:4px; }
  .metricrow { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:4px 0 6px; }
  .metricrow > div { background:var(--panel); border:1px solid var(--border); border-radius:8px;
                     padding:10px 14px; display:flex; flex-direction:column; }
  .metricrow .lbl { font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:var(--muted); }
  .metricrow .val { font-size:17px; font-weight:600; font-variant-numeric:tabular-nums; }
  .metricrow .val code { font-size:13px; }
  .callout { border-left:3px solid var(--accent); background:var(--panel); padding:12px 16px;
             border-radius:0 8px 8px 0; margin:16px 0; }
  .callout.warn { border-left-color:var(--warn); }
  .callout.bad { border-left-color:var(--block); }
  .callout p { margin:6px 0; } .callout strong { color:#fff; }
  ul { padding-left:22px; margin:10px 0; } li { margin:6px 0; }
  .fine { font-size:12.5px; color:var(--muted); }
  details { margin:10px 0 0; }
  summary { cursor:pointer; color:var(--accent); font-size:13px; padding:6px 0; }
  table.mini { font-size:13px; margin-top:6px; } table.mini td { padding:6px 12px; }
  footer { margin-top:50px; padding-top:18px; border-top:1px solid var(--border);
           color:var(--muted); font-size:12.5px; }
  @media print {
    body { background:#fff; color:#111; padding:0; }
    .card,.metricrow > div,table { background:#fff; border-color:#ccc; }
    th { background:#eee; color:#333; }
    details > table { display:block; }
  }
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>Apigee API Usage</h1>
  <p class="sub">Organization <code>${esc(ORG)}</code> &middot; ${good.length} environment${good.length === 1 ? '' : 's'} &middot; via <code>${esc(BASE_URL)}</code></p>
  <p class="sub">Metric <code>${TIME_UNIT_METRIC}</code> &middot; dimension <code>${DIM}</code> &middot; window ${esc(win.label)}</p>
  <span class="asof">Generated ${esc(generated)}</span>
</header>

<div class="cards">
  <div class="card"><div class="k">Total calls</div><div class="v">${num(orgTotal)}</div></div>
  <div class="card"><div class="k">Environments</div><div class="v">${good.length}</div></div>
  <div class="card"><div class="k">Active proxy&#8209;env pairs</div><div class="v">${activePairs}</div></div>
  <div class="card"><div class="k">Distinct proxies</div><div class="v">${distinct.size} <small style="font-size:13px;color:var(--muted);font-weight:400">of ${knownProxies.size}</small></div></div>
</div>

${unknown.length ? `<div class="callout bad">
  <p><strong>Integrity check FAILED.</strong> ${unknown.length} name(s) returned by analytics are not defined in <code>/apis</code>:</p>
  <p class="fine">${unknown.slice(0, 20).map(esc).join(', ')}${unknown.length > 20 ? ' &hellip;' : ''}</p>
</div>` : `<div class="callout">
  <p><strong>Integrity check passed.</strong> All ${activePairs} proxy&ndash;environment pairs resolve against <code>GET /apis</code>.</p>
  <p class="fine">The <code>apiproxy</code> dimension returns real proxy names. The similarly named <code>proxy</code> dimension does not &mdash; it is a coarse grouping in which <code>default</code> alone spans dozens of proxies.</p>
</div>`}

${failedBlock}

<h2 id="totals">1. Totals by environment</h2>
<table>
  <thead><tr><th>Environment</th><th class="num">Active proxies</th><th class="num">Calls</th><th class="num">Share</th><th class="bars">Volume</th><th class="num">Top proxy share</th></tr></thead>
  <tbody>
${totalsRows}
    <tr><td><strong>Total</strong></td><td class="num">${activePairs}</td><td class="num"><strong>${num(orgTotal)}</strong></td><td class="num">100%</td><td class="bars"></td><td class="num">&mdash;</td></tr>
  </tbody>
</table>

<h2 id="orgwide">2. Top proxies across the whole organization</h2>
<p>Traffic summed over every environment, so a proxy active in several places appears once.</p>
<table>
  <thead><tr><th class="num">#</th><th>API proxy</th><th class="num">Calls</th><th class="num">Share</th><th class="bars">Volume</th><th class="num">Envs</th></tr></thead>
  <tbody>
${rollupRows || '<tr><td colspan="6" class="fine">No traffic in this window.</td></tr>'}
  </tbody>
</table>

<h2 id="environments">3. Per-environment detail</h2>
<p>Top ${TOP_N} proxies in each environment; the rest are collapsed.</p>
${envSections || '<p class="fine">No environment recorded traffic in this window.</p>'}

<h2 id="method">4. How this was measured</h2>
<table>
  <thead><tr><th>Item</th><th>Value</th></tr></thead>
  <tbody>
    <tr><td>Source</td><td><code>GET /v1/organizations/${esc(ORG)}/environments/{env}/stats/${DIM}</code></td></tr>
    <tr><td>Parameters</td><td><code>select=${TIME_UNIT_METRIC}</code> &middot; <code>timeRange=${esc(range)}</code></td></tr>
    <tr><td>Dimension</td><td><code>${DIM}</code> &mdash; the API proxy name</td></tr>
    <tr><td>Name integrity</td><td>${activePairs} names checked against <code>GET /apis</code> (${knownProxies.size} defined) &mdash; ${unknown.length} unknown</td></tr>
    <tr><td>Aggregation</td><td>Summed over the window; shares against each environment's own total</td></tr>
    <tr><td>Access path</td><td>Local read-through proxy, loopback only</td></tr>
    <tr><td>Nature of the run</td><td>Read-only &mdash; GET requests only, nothing created or modified</td></tr>
  </tbody>
</table>

<div class="callout warn">
  <p><strong>Analytics is eventually consistent.</strong> Re-running the same window minutes apart shifts totals by a few dozen calls. A window that includes today is partial. Apigee may also drop dimensions with no traffic, so an absent proxy means "no calls recorded", not "not deployed".</p>
</div>

<footer>
  Apigee API Usage &mdash; <code>${esc(ORG)}</code><br>
  Generated ${esc(generated)} &middot; window ${esc(range)} &middot; by apigee-usage-report.js
</footer>

</div>
</body>
</html>
`;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

(async () => {
  try {
    const data = await collect();
    const { results, unknown, win, range } = data;

    if (!QUIET) {
      console.log(`\nApigee API usage - ${ORG}`);
      console.log(`  window   ${range}  (${win.label})`);
      console.log(`  proxies  ${data.knownProxies.size} defined in /apis`);
      console.log('');
      const total = results.filter(r => r.ok).reduce((s, r) => s + r.total, 0);
      for (const r of results) {
        if (!r.ok) { console.log(`  ${r.env.padEnd(10)} ERROR ${r.error}`); continue; }
        const top = r.rows[0];
        console.log(`  ${r.env.padEnd(10)} ${num(r.total).padStart(12)} calls  ${String(r.rows.length).padStart(3)} proxies  top: ${top ? top.name : '-'}`);
      }
      console.log(`  ${'TOTAL'.padEnd(10)} ${num(total).padStart(12)} calls`);
      console.log('');
      console.log(unknown.length
        ? `  integrity: FAILED - ${unknown.length} unknown name(s): ${unknown.slice(0, 8).join(', ')}`
        : `  integrity: PASSED - every name matches /apis`);
    }

    const html = buildHtml(data);
    const outPath = path.resolve(OUT);
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(`\n  report   ${outPath}`);

    if (JSON_OUT) {
      const jsonPath = path.resolve(JSON_OUT);
      fs.writeFileSync(jsonPath, JSON.stringify({
        org: ORG, generatedAt: new Date().toISOString(), window: { label: win.label, range },
        environments: results.map(r => ({
          env: r.env, ok: r.ok, total: r.total, error: r.error || null,
          proxies: r.rows.map(x => ({ proxy: x.name, calls: x.calls })),
        })),
        integrity: { checked: data.knownProxies.size, unknown },
      }, null, 2), 'utf8');
      console.log(`  json     ${jsonPath}`);
    }

    if (unknown.length) {
      console.error('\n  WARNING: analytics returned names missing from /apis. The report is written but suspect.');
      process.exitCode = 2;
      return;
    }
  } catch (e) {
    console.error(`\n  ERROR ${e.message}`);
    if (/ECONNREFUSED|fetch failed/i.test(e.message)) {
      console.error(`  Is the proxy running at ${BASE_URL}?`);
    }
    process.exitCode = 1;
  }
})();
