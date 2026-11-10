import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  GOOGLE_APPLICATION_CREDENTIALS: 'C:/keys/service-account.json',
};

test('applies sane defaults', () => {
  const config = loadConfig({ ...baseEnv });

  assert.equal(config.target, 'https://apigee.googleapis.com');
  assert.equal(config.port, 8080);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.keyFile, 'C:/keys/service-account.json');
  assert.deepEqual(config.scopes, ['https://www.googleapis.com/auth/cloud-platform']);
  assert.deepEqual(config.allowedPathPrefixes, []);
  assert.deepEqual(config.allowedMethods, []);
  assert.equal(config.basePath, '');
  assert.equal(config.timeoutMs, 60_000);
  assert.equal(config.verifyTls, true);
});

test('requires a service account key path', () => {
  assert.throws(() => loadConfig({}), /Missing service account key file/);
});

test('rejects a plaintext target unless explicitly allowed', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, TARGET_URL: 'http://127.0.0.1:9000' }),
    /not HTTPS/,
  );

  const config = loadConfig({
    ...baseEnv,
    TARGET_URL: 'http://127.0.0.1:9000',
    ALLOW_INSECURE_TARGET: 'true',
  });
  assert.equal(config.target, 'http://127.0.0.1:9000');
});

test('parses scopes, allowed prefixes, base path and numeric settings', () => {
  const config = loadConfig({
    ...baseEnv,
    GOOGLE_SCOPES: 'https://www.googleapis.com/auth/cloud-platform, https://www.googleapis.com/auth/apigee',
    ALLOWED_PATH_PREFIXES: '/v1/organizations, /v1/organizations/',
    ALLOWED_METHODS: 'get, Post',
    BASE_PATH: '/apigee/',
    PORT: '9000',
    PROXY_TIMEOUT_MS: '15000',
    TARGET_TLS_VERIFY: 'false',
  });

  assert.deepEqual(config.scopes, [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/apigee',
  ]);
  assert.deepEqual(config.allowedPathPrefixes, ['/v1/organizations', '/v1/organizations/']);
  assert.deepEqual(config.allowedMethods, ['GET', 'POST']);
  assert.equal(config.basePath, '/apigee');
  assert.equal(config.port, 9000);
  assert.equal(config.timeoutMs, 15_000);
  assert.equal(config.verifyTls, false);
});

test('rejects invalid numeric settings', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, PORT: 'not-a-number' }),
    /PORT must be a positive integer/,
  );
});
