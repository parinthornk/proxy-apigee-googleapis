#!/usr/bin/env node
'use strict';

/**
 * verify-proxy.js — smoke test for the Apigee local management proxy.
 *
 * Read-only by design: it never creates, modifies, or deletes anything, so it is
 * safe to run repeatedly and from CI.
 *
 * Usage:
 *   node verify-proxy.js
 *   node verify-proxy.js http://localhost:8080
 *   BASE_URL=http://localhost:8080 ORG=gcp-pttep-th-it-apimgmt-dev ENV=dev node verify-proxy.js
 *   NO_COLOR=1 node verify-proxy.js
 *
 * Exit codes: 0 = all checks passed, 1 = one or more checks failed.
 */

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const ORG = process.env.ORG || 'gcp-pttep-th-it-apimgmt-dev';
const ENV = process.env.ENV || 'dev';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000);

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const grey = (s) => paint('90', s);
const bold = (s) => paint('1', s);

const results = [];
const record = (level, name, detail, ms) => {
  results.push({ level, name, detail, ms });
  const mark = level === 'pass' ? green('[ OK ]') : level === 'warn' ? yellow('[WARN]') : red('[FAIL]');
  const timing = ms == null ? '' : grey(` ${ms}ms`);
  console.log(`${mark} ${name}${timing}`);
  if (detail && level !== 'pass') console.log(grey(`       ${detail}`));
};

const pass = (name, detail, ms) => record('pass', name, detail, ms);
const warn = (name, detail, ms) => record('warn', name, detail, ms);
const fail = (name, detail, ms) => record('fail', name, detail, ms);

async function req(path, opts = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout ?? TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text; // non-JSON (e.g. an HTML error page) stays as raw text
  }
  return { status: res.status, headers: res.headers, body, text, ms: Date.now() - started };
}

const snippet = (r) =>
  typeof r.body === 'string'
    ? r.body.replace(/\s+/g, ' ').slice(0, 160)
    : JSON.stringify(r.body).slice(0, 160);

const isApigeeError = (b) =>
  b && typeof b === 'object' && b.error && typeof b.error === 'object' && typeof b.error.code === 'number';

// Apigee's sync analytics expects MM/DD/YYYY HH:mm in the datastore's timezone.
const asApigeeTime = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

async function main() {
  console.log(bold('\nApigee local management proxy — verification'));
  console.log(grey(`  base : ${BASE}`));
  console.log(grey(`  org  : ${ORG}`));
  console.log(grey(`  env  : ${ENV}`));
  console.log();

  // ---- 1. Reachability -------------------------------------------------------
  let envRes;
  try {
    envRes = await req(`/v1/organizations/${ORG}/environments`);
  } catch (err) {
    const reason = err.cause?.code || err.code || err.name || 'unknown error';
    fail('proxy is reachable', `connection failed (${reason}) — is the proxy running on ${BASE}?`);
    return finish();
  }
  if (envRes.status >= 500) {
    fail('proxy is reachable', `HTTP ${envRes.status} for /environments`, envRes.ms);
    return finish();
  }
  pass('proxy is reachable', null, envRes.ms);

  // ---- 2. Environments -------------------------------------------------------
  if (envRes.status === 200 && Array.isArray(envRes.body) && envRes.body.length > 0) {
    pass(`environments list (${envRes.body.length} found: ${envRes.body.join(', ')})`, null, envRes.ms);
    if (!envRes.body.includes(ENV)) {
      warn(`ENV "${ENV}" is not in the org's environment list`, `analytics checks will likely fail`);
    }
  } else if (envRes.status === 403) {
    fail('environments list', '403 PERMISSION_DENIED — check ORG and the proxy credentials', envRes.ms);
  } else {
    fail('environments list', `unexpected HTTP ${envRes.status}: ${snippet(envRes)}`, envRes.ms);
  }

  // ---- 3. API proxy list -----------------------------------------------------
  const listRes = await req(`/v1/organizations/${ORG}/apis`);
  let proxyNames = [];
  if (listRes.status !== 200 || !Array.isArray(listRes.body?.proxies)) {
    fail('API proxy list', `unexpected HTTP ${listRes.status}: ${snippet(listRes)}`, listRes.ms);
  } else {
    const raw = listRes.body.proxies;
    proxyNames = raw.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
    const dupes = proxyNames.filter((n, i) => proxyNames.indexOf(n) !== i);
    if (proxyNames.length === 0) {
      warn('API proxy list returned no proxies', 'org may be empty', listRes.ms);
    } else if (dupes.length) {
      fail('API proxy list', `duplicate names: ${[...new Set(dupes)].join(', ')}`, listRes.ms);
    } else {
      pass(`API proxy list (${proxyNames.length} proxies, no duplicates)`, null, listRes.ms);
    }
  }

  // ---- 4. Single proxy detail ------------------------------------------------
  if (proxyNames.length) {
    const name = proxyNames[0];
    const oneRes = await req(`/v1/organizations/${ORG}/apis/${encodeURIComponent(name)}`);
    const b = oneRes.body;
    if (oneRes.status === 200 && b?.name === name && Array.isArray(b.revision) && b.revision.length) {
      pass(`proxy detail (${name}, revision ${b.revision.join(',')})`, null, oneRes.ms);
    } else {
      fail(`proxy detail (${name})`, `unexpected HTTP ${oneRes.status}: ${snippet(oneRes)}`, oneRes.ms);
    }
  }

  // ---- 5. Error handling -----------------------------------------------------
  const bogus = `__verify_${Date.now()}`;
  const missingRes = await req(`/v1/organizations/${ORG}/apis/${bogus}`);
  if (missingRes.status === 404 && isApigeeError(missingRes.body) && missingRes.body.error.code === 404) {
    pass('missing proxy returns a well-formed 404', null, missingRes.ms);
  } else if (missingRes.status === 403) {
    warn('missing proxy returned 403 instead of 404', 'Apigee hides resource existence; not a proxy fault', missingRes.ms);
  } else {
    fail('missing proxy error shape', `HTTP ${missingRes.status}: ${snippet(missingRes)}`, missingRes.ms);
  }

  // ---- 6. Auth injection -----------------------------------------------------
  try {
    const authRes = await req(`/v1/organizations/${ORG}/apis`, {
      headers: { Authorization: 'Bearer this-token-is-invalid-on-purpose' },
    });
    if (authRes.status === 200) {
      pass('client Authorization header is overridden (bogus token still works)', null, authRes.ms);
    } else if (authRes.status === 401) {
      warn('bogus bearer token caused 401', 'proxy is NOT injecting credentials for this path', authRes.ms);
    } else {
      warn('auth-override check inconclusive', `HTTP ${authRes.status}`, authRes.ms);
    }
  } catch (err) {
    warn('auth-override check could not run', err.message);
  }

  // ---- 7. Analytics: sync stats ---------------------------------------------
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const timeRange = `${asApigeeTime(start)}~${asApigeeTime(end)}`;
  const statsPath =
    `/v1/organizations/${ORG}/environments/${ENV}/stats/proxy` +
    `?select=${encodeURIComponent('sum(message_count)')}` +
    `&timeUnit=day&timeRange=${encodeURIComponent(timeRange)}`;
  const statsRes = await req(statsPath, { timeout: Math.max(TIMEOUT_MS, 45000) });
  if (statsRes.status === 200 && Array.isArray(statsRes.body?.environments)) {
    pass('analytics sync stats (/stats/proxy)', null, statsRes.ms);
  } else if (statsRes.status === 400 && isApigeeError(statsRes.body)) {
    warn('analytics sync stats rejected', statsRes.body.error.message, statsRes.ms);
  } else {
    fail('analytics sync stats', `unexpected HTTP ${statsRes.status}: ${snippet(statsRes)}`, statsRes.ms);
  }

  // ---- 8. Analytics: async query listing ------------------------------------
  const queriesRes = await req(`/v1/organizations/${ORG}/environments/${ENV}/queries`);
  if (queriesRes.status === 200 && Array.isArray(queriesRes.body?.queries)) {
    pass(`analytics query list (${queriesRes.body.queries.length} jobs)`, null, queriesRes.ms);
  } else {
    fail('analytics query list', `unexpected HTTP ${queriesRes.status}: ${snippet(queriesRes)}`, queriesRes.ms);
  }

  // ---- 9. Method policy ------------------------------------------------------
  // DELETE is expected to be blocked by the proxy before reaching Apigee.
  try {
    const delRes = await req(`/v1/organizations/${ORG}/environments/${ENV}/queries/00000000-0000-0000-0000-000000000000`, {
      method: 'DELETE',
    });
    if (delRes.status === 405 && delRes.body?.error === 'method_not_allowed') {
      pass('write methods are still gated (DELETE → 405)', null, delRes.ms);
    } else if (delRes.status === 404) {
      warn('DELETE appears to be enabled on /queries', 'a nonexistent id returned 404, so writes now reach Apigee', delRes.ms);
    } else {
      warn('method policy check inconclusive', `HTTP ${delRes.status}: ${snippet(delRes)}`, delRes.ms);
    }
  } catch (err) {
    warn('method policy check could not run', err.message);
  }

  finish();
}

function finish() {
  const passed = results.filter((r) => r.level === 'pass').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  const failed = results.filter((r) => r.level === 'fail').length;
  const slowest = results.filter((r) => r.ms != null).sort((a, b) => b.ms - a.ms)[0];

  console.log();
  console.log(bold('Summary'));
  console.log(`  ${green(`${passed} passed`)}   ${warned ? yellow(`${warned} warned`) : grey('0 warned')}   ${failed ? red(`${failed} failed`) : grey('0 failed')}`);
  if (slowest) console.log(grey(`  slowest: ${slowest.name} — ${slowest.ms}ms`));

  if (failed === 0) {
    console.log(green('\nRESULT: proxy is working.\n'));
    process.exit(0);
  }
  console.log(red('\nRESULT: proxy has problems — see [FAIL] lines above.\n'));
  process.exit(1);
}

main().catch((err) => {
  fail('unexpected error', err.stack || String(err));
  finish();
});
