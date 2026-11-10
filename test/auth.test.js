import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenProvider, loadServiceAccount } from '../src/auth.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function writeTempJson(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'sa-key-'));
  const file = join(dir, 'key.json');
  writeFileSync(file, contents);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const validCredentials = {
  type: 'service_account',
  project_id: 'demo-project',
  private_key_id: 'abc123',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
  client_email: 'demo@demo-project.iam.gserviceaccount.com',
};

test('loadServiceAccount reads a valid service account file', () => {
  const { file, cleanup } = writeTempJson(JSON.stringify(validCredentials));
  try {
    const credentials = loadServiceAccount(file);
    assert.equal(credentials.client_email, validCredentials.client_email);
  } finally {
    cleanup();
  }
});

test('loadServiceAccount rejects a missing file with a clear message', () => {
  assert.throws(() => loadServiceAccount(join(tmpdir(), 'does-not-exist-key.json')), /Cannot read/);
});

test('loadServiceAccount rejects invalid JSON', () => {
  const { file, cleanup } = writeTempJson('{not json');
  try {
    assert.throws(() => loadServiceAccount(file), /does not contain valid JSON/);
  } finally {
    cleanup();
  }
});

test('loadServiceAccount rejects a non service-account JSON document', () => {
  const { file, cleanup } = writeTempJson(JSON.stringify({ type: 'authorized_user' }));
  try {
    assert.throws(() => loadServiceAccount(file), /not a Google service account key/);
  } finally {
    cleanup();
  }
});

function fakeClient(handler) {
  return { getAccessToken: handler };
}

test('caches the access token until it expires', async () => {
  let nowMs = 1_000_000;
  let calls = 0;
  const client = fakeClient(async () => {
    calls += 1;
    return { token: `token-${calls}`, res: { data: { expiry_date: nowMs + 3_600_000 } } };
  });

  const provider = createTokenProvider({ client, now: () => nowMs });

  assert.equal(await provider.getToken(), 'token-1');
  assert.equal(await provider.getToken(), 'token-1');
  assert.equal(calls, 1);

  nowMs += 3_600_000;
  assert.equal(await provider.getToken(), 'token-2');
  assert.equal(calls, 2);
});

test('deduplicates concurrent token refreshes', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = fakeClient(async () => {
    calls += 1;
    await gate;
    return { token: 'shared-token', res: { data: { expiry_date: Date.now() + 3_600_000 } } };
  });

  const provider = createTokenProvider({ client });

  const first = provider.getToken();
  const second = provider.getToken();
  release();

  assert.equal(await first, 'shared-token');
  assert.equal(await second, 'shared-token');
  assert.equal(calls, 1);
});

test('falls back to a short TTL when the auth response omits expiry_date', async () => {
  let nowMs = 0;
  let calls = 0;
  const client = fakeClient(async () => {
    calls += 1;
    return { token: `token-${calls}` };
  });

  const provider = createTokenProvider({ client, now: () => nowMs });
  assert.equal(await provider.getToken(), 'token-1');

  nowMs += 10 * 60_000;
  assert.equal(await provider.getToken(), 'token-1');
  assert.equal(calls, 1);

  nowMs += 60 * 60_000;
  assert.equal(await provider.getToken(), 'token-2');
  assert.equal(calls, 2);
});

test('propagates auth failures and retries on the next call', async () => {
  let calls = 0;
  const client = fakeClient(async () => {
    calls += 1;
    if (calls === 1) throw new Error('invalid_grant');
    return { token: 'recovered', res: { data: { expiry_date: Date.now() + 3_600_000 } } };
  });

  const provider = createTokenProvider({ client });

  await assert.rejects(() => provider.getToken(), /invalid_grant/);
  assert.equal(await provider.getToken(), 'recovered');
  assert.equal(calls, 2);
});

test('rejects an empty access token', async () => {
  const client = fakeClient(async () => ({ token: null }));
  const provider = createTokenProvider({ client });
  await assert.rejects(() => provider.getToken(), /empty access token/);
});

test('produces a bearer authorization header', async () => {
  const client = fakeClient(async () => ({
    token: 'abc',
    res: { data: { expiry_date: Date.now() + 3_600_000 } },
  }));
  const provider = createTokenProvider({ client });
  assert.equal(await provider.getAuthorizationHeader(), 'Bearer abc');
});
