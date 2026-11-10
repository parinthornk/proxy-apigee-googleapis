import process from 'node:process';

const DEFAULT_TARGET = 'https://apigee.googleapis.com';
const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 60_000;

function readInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${value}"`);
  }
  return parsed;
}

function readBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function readList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBasePath(value) {
  const trimmed = (value ?? '').trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

export function loadConfig(env = process.env) {
  const target = (env.TARGET_URL ?? DEFAULT_TARGET).replace(/\/+$/, '');
  const targetUrl = new URL(target);

  const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS ?? env.SA_KEY_FILE ?? '';
  if (!keyFile) {
    throw new Error(
      'Missing service account key file. Set GOOGLE_APPLICATION_CREDENTIALS (or SA_KEY_FILE) to the path of the Google service account JSON file.',
    );
  }

  const config = {
    target,
    port: readInt(env.PORT, DEFAULT_PORT, 'PORT'),
    host: env.HOST ?? DEFAULT_HOST,
    keyFile,
    scopes: readList(env.GOOGLE_SCOPES).length ? readList(env.GOOGLE_SCOPES) : DEFAULT_SCOPES,
    subject: env.GOOGLE_IMPERSONATE_SUBJECT || undefined,
    allowedPathPrefixes: readList(env.ALLOWED_PATH_PREFIXES),
    allowedMethods: readList(env.ALLOWED_METHODS).map((method) => method.toUpperCase()),
    basePath: normalizeBasePath(env.BASE_PATH),
    timeoutMs: readInt(env.PROXY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'PROXY_TIMEOUT_MS'),
    verifyTls: readBool(env.TARGET_TLS_VERIFY, true),
    logRequests: readBool(env.LOG_REQUESTS, true),
    targetIsHttps: targetUrl.protocol === 'https:',
  };

  if (config.targetIsHttps === false && readBool(env.ALLOW_INSECURE_TARGET, false) === false) {
    throw new Error(
      `TARGET_URL "${target}" is not HTTPS. Service account bearer tokens must not be sent over plaintext. Set ALLOW_INSECURE_TARGET=true only for local testing.`,
    );
  }

  return config;
}
