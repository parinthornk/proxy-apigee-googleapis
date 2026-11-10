import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { close, listen, makeConfig, startProxy, startUpstream, urlFor } from '../test-utils/helpers.js';

const READ_ONLY_PREFIXES = [
  '/v1/organizations/*/apis',
  '/v1/organizations/*/apiproducts',
  '/v1/organizations/*/deployments',
  '/v1/organizations/*/environments/*/deployments',
  '/v1/organizations/*/environments/*/apis/*/deployments',
  '/v1/organizations/*/environments/*/apis/*/revisions/*/deployments',
  '/v1/organizations/*/environments/*/targetservers',
];

function fixedTokenProvider(token = 'Bearer sa-token') {
  let calls = 0;
  return {
    calls: () => calls,
    async getAuthorizationHeader() {
      calls += 1;
      return token;
    },
    async getToken() {
      calls += 1;
      return token.replace(/^Bearer /, '');
    },
  };
}

test('health check works without calling Google', async (t) => {
  const tokenProvider = fixedTokenProvider();
  const proxy = await startProxy({ config: makeConfig(), tokenProvider });
  t.after(proxy.close);

  const res = await fetch(`${proxy.baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', target: 'https://apigee.googleapis.com' });
  assert.equal(tokenProvider.calls(), 0);
});

test('forwards method, path, query, body and injects the service account token', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    config: makeConfig({ target: upstream.url }),
    tokenProvider: fixedTokenProvider(),
  });
  t.after(proxy.close);
  t.after(upstream.close);

  const res = await fetch(`${proxy.baseUrl}/v1/organizations/demo/apis?pageSize=5`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-supplied', 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-upstream'), 'yes');
  assert.deepEqual(await res.json(), { ok: true });

  assert.equal(upstream.requests.length, 1);
  const [received] = upstream.requests;
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/v1/organizations/demo/apis?pageSize=5');
  assert.equal(received.headers.authorization, 'Bearer sa-token');
  assert.equal(received.headers.host, `127.0.0.1:${upstream.server.address().port}`);
  assert.deepEqual(JSON.parse(received.body), { hello: 'world' });
});

test('enforces the allowed path prefixes and still serves health checks', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    config: makeConfig({
      target: upstream.url,
      allowedPathPrefixes: ['/v1/organizations'],
    }),
    tokenProvider: fixedTokenProvider(),
  });
  t.after(proxy.close);
  t.after(upstream.close);

  const allowed = await fetch(`${proxy.baseUrl}/v1/organizations/demo/apis`);
  assert.equal(allowed.status, 200);

  const blocked = await fetch(`${proxy.baseUrl}/v1/apps`);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, 'path_not_allowed');

  const health = await fetch(`${proxy.baseUrl}/healthz`);
  assert.equal(health.status, 200);

  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].url, '/v1/organizations/demo/apis');
});

test('strips the configured base path before forwarding', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    config: makeConfig({ target: upstream.url, basePath: '/apigee' }),
    tokenProvider: fixedTokenProvider(),
  });
  t.after(proxy.close);
  t.after(upstream.close);

  const res = await fetch(`${proxy.baseUrl}/apigee/v1/organizations?x=1`);
  assert.equal(res.status, 200);
  assert.equal(upstream.requests[0].url, '/v1/organizations?x=1');
});

test('rejects disallowed HTTP methods with 405 and an Allow header', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    config: makeConfig({ target: upstream.url, allowedMethods: ['GET'] }),
    tokenProvider: fixedTokenProvider(),
  });
  t.after(proxy.close);
  t.after(upstream.close);

  const allowed = await fetch(`${proxy.baseUrl}/v1/organizations/demo/apis`);
  assert.equal(allowed.status, 200);

  const blocked = await fetch(`${proxy.baseUrl}/v1/organizations/demo/apis`, { method: 'POST' });
  assert.equal(blocked.status, 405);
  assert.equal(blocked.headers.get('allow'), 'GET');
  assert.equal((await blocked.json()).error, 'method_not_allowed');

  assert.equal(upstream.requests.length, 1);
});

test('matches a wildcard org segment for the apis and apiproducts subtrees', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    config: makeConfig({
      target: upstream.url,
      allowedPathPrefixes: ['/v1/organizations/*/apis', '/v1/organizations/*/apiproducts'],
    }),
    tokenProvider: fixedTokenProvider(),
  });
  t.after(proxy.close);
  t.after(upstream.close);

  const apis = await fetch(`${proxy.baseUrl}/v1/organizations/my-org/apis/demo/revisions/3`);
  assert.equal(apis.status, 200);

  const products = await fetch(`${proxy.baseUrl}/v1/organizations/my-org/apiproducts/premium`);
  assert.equal(products.status, 200);

  const apps = await fetch(`${proxy.baseUrl}/v1/organizations/my-org/apps`);
  assert.equal(apps.status, 403);
  assert.equal((await apps.json()).error, 'path_not_allowed');

  assert.equal(upstream.requests.length, 2);
});

test('read-only allowlist covers deployments, proxy bundle and target servers', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    config: makeConfig({
      target: upstream.url,
      allowedMethods: ['GET'],
      allowedPathPrefixes: READ_ONLY_PREFIXES,
    }),
    tokenProvider: fixedTokenProvider(),
  });
  t.after(proxy.close);
  t.after(upstream.close);

  const paths = [
    '/v1/organizations/my-org/deployments',
    '/v1/organizations/my-org/environments/prod/deployments',
    '/v1/organizations/my-org/apis/demo/deployments',
    '/v1/organizations/my-org/environments/prod/apis/demo/deployments',
    '/v1/organizations/my-org/environments/prod/apis/demo/revisions/3/deployments',
    '/v1/organizations/my-org/environments/prod/targetservers',
    '/v1/organizations/my-org/environments/prod/targetservers/backend',
    '/v1/organizations/my-org/apis/demo/revisions/3?format=bundle',
  ];

  for (const path of paths) {
    const res = await fetch(`${proxy.baseUrl}${path}`);
    assert.equal(res.status, 200, `expected 200 for ${path}`);
  }

  const blocked = await fetch(`${proxy.baseUrl}/v1/organizations/my-org/apps`);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, 'path_not_allowed');

  const blockedWrite = await fetch(`${proxy.baseUrl}/v1/organizations/my-org/apis`, { method: 'POST' });
  assert.equal(blockedWrite.status, 405);

  assert.equal(upstream.requests.length, paths.length);
});

test('streams a binary proxy bundle download with the query intact', async (t) => {
  const bundle = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x00, 0x99]);
  const seen = [];
  const upstreamServer = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': bundle.length,
    });
    res.end(bundle);
  });
  await listen(upstreamServer);

  const proxy = await startProxy({
    config: makeConfig({
      target: urlFor(upstreamServer),
      allowedMethods: ['GET'],
      allowedPathPrefixes: ['/v1/organizations/*/apis'],
    }),
    tokenProvider: fixedTokenProvider(),
  });
  t.after(proxy.close);
  t.after(() => close(upstreamServer));

  const res = await fetch(
    `${proxy.baseUrl}/v1/organizations/my-org/apis/demo/revisions/7?format=bundle`,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bundle);
  assert.deepEqual(seen, ['/v1/organizations/my-org/apis/demo/revisions/7?format=bundle']);
});

test('evaluates allowed prefixes against the path after stripping the base path', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    config: makeConfig({
      target: upstream.url,
      basePath: '/apigee',
      allowedPathPrefixes: ['/v1/organizations/*/apis'],
    }),
    tokenProvider: fixedTokenProvider(),
  });
  t.after(proxy.close);
  t.after(upstream.close);

  const res = await fetch(`${proxy.baseUrl}/apigee/v1/organizations/my-org/apis`);
  assert.equal(res.status, 200);
  assert.equal(upstream.requests[0].url, '/v1/organizations/my-org/apis');
});

test('returns 502 without contacting the upstream when the token cannot be obtained', async (t) => {
  const upstream = await startUpstream();
  const proxy = await startProxy({
    config: makeConfig({ target: upstream.url }),
    tokenProvider: {
      async getAuthorizationHeader() {
        throw new Error('credentials unavailable');
      },
    },
  });
  t.after(proxy.close);
  t.after(upstream.close);

  const res = await fetch(`${proxy.baseUrl}/v1/organizations/demo`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'auth_failed');
  assert.equal(upstream.requests.length, 0);
});

test('returns 502 when the target is unreachable', async (t) => {
  const proxy = await startProxy({
    config: makeConfig({ target: 'http://127.0.0.1:1' }),
    tokenProvider: fixedTokenProvider(),
  });
  t.after(proxy.close);

  const res = await fetch(`${proxy.baseUrl}/v1/organizations/demo`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_error');
});
