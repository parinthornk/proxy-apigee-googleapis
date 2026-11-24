import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';

const EXPIRY_SKEW_MS = 60_000;
const FALLBACK_TOKEN_TTL_MS = 55 * 60_000;
const STATIC_TOKEN_HINT =
  'A static access token expires and must be replaced manually when Google starts returning 401.';

export function loadServiceAccount(keyFile) {
  let raw;
  try {
    raw = readFileSync(keyFile, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read the service account file "${keyFile}": ${err.message}`);
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error(`The service account file "${keyFile}" does not contain valid JSON.`);
  }

  if (
    credentials.type !== 'service_account' ||
    !credentials.client_email ||
    !credentials.private_key
  ) {
    throw new Error(
      `The file "${keyFile}" is not a Google service account key. Expected JSON with type "service_account", client_email and private_key.`,
    );
  }

  return credentials;
}

export function createJwtClient({ credentials, scopes, subject }) {
  return new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    keyId: credentials.private_key_id,
    scopes,
    subject,
  });
}

export function createTokenProvider({
  credentials,
  keyFile,
  scopes = ['https://www.googleapis.com/auth/cloud-platform'],
  subject,
  client,
  now = Date.now,
}) {
  const jwtClient =
    client ?? createJwtClient({ credentials: credentials ?? loadServiceAccount(keyFile), scopes, subject });

  let cached = null;
  let inFlight = null;

  async function refresh() {
    const startedAt = now();
    const { token, res } = await jwtClient.getAccessToken();
    if (!token) {
      throw new Error('Google authorization server returned an empty access token.');
    }

    const expiryDate = res?.data?.expiry_date;
    const expiresAt = Number.isFinite(expiryDate)
      ? expiryDate - EXPIRY_SKEW_MS
      : startedAt + FALLBACK_TOKEN_TTL_MS;

    cached = { token, expiresAt };
    return token;
  }

  async function getToken() {
    if (cached && now() < cached.expiresAt) {
      return cached.token;
    }

    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  return {
    mode: 'service_account',
    getToken,
    async getAuthorizationHeader() {
      return `Bearer ${await getToken()}`;
    },
    reset() {
      cached = null;
      inFlight = null;
    },
  };
}

export function normalizeStaticToken(token) {
  return String(token ?? '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
}

export function createStaticTokenProvider({ token }) {
  const value = normalizeStaticToken(token);
  if (!value) {
    throw new Error('STATIC_ACCESS_TOKEN is empty; provide a Google access token such as "ya29...".');
  }

  const header = `Bearer ${value}`;
  return {
    mode: 'static_token',
    async getToken() {
      return value;
    },
    async getAuthorizationHeader() {
      return header;
    },
    reset() {},
  };
}

export function createTokenProviderWithFallback({ primary, staticToken, logger = console }) {
  const fallback = createStaticTokenProvider({ token: staticToken });
  let usingFallback = false;

  async function getToken() {
    if (usingFallback) return fallback.getToken();

    try {
      return await primary.getToken();
    } catch (err) {
      usingFallback = true;
      logger.warn?.(
        `Service account token request failed (${err.message}); falling back to STATIC_ACCESS_TOKEN. ${STATIC_TOKEN_HINT}`,
      );
      return fallback.getToken();
    }
  }

  return {
    mode: 'service_account_with_static_fallback',
    getToken,
    async getAuthorizationHeader() {
      return `Bearer ${await getToken()}`;
    },
    reset() {
      usingFallback = false;
      primary.reset?.();
    },
  };
}

export function createAuthTokenProvider({
  keyFile,
  scopes,
  subject,
  staticToken,
  logger = console,
}) {
  const hasStaticToken = Boolean(normalizeStaticToken(staticToken));

  if (!keyFile) {
    if (!hasStaticToken) {
      throw new Error(
        'Missing service account key file. Set GOOGLE_APPLICATION_CREDENTIALS (or SA_KEY_FILE) to the path of the Google service account JSON file, or set STATIC_ACCESS_TOKEN to a temporary Google access token.',
      );
    }
    logger.warn?.(
      `No service account key file configured; authenticating with STATIC_ACCESS_TOKEN. ${STATIC_TOKEN_HINT}`,
    );
    return createStaticTokenProvider({ token: staticToken });
  }

  let primary;
  try {
    primary = createTokenProvider({ keyFile, scopes, subject });
  } catch (err) {
    if (!hasStaticToken) throw err;
    logger.warn?.(
      `Cannot use the service account key (${err.message}); authenticating with STATIC_ACCESS_TOKEN. ${STATIC_TOKEN_HINT}`,
    );
    return createStaticTokenProvider({ token: staticToken });
  }

  return hasStaticToken
    ? createTokenProviderWithFallback({ primary, staticToken, logger })
    : primary;
}
