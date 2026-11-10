import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';

const EXPIRY_SKEW_MS = 60_000;
const FALLBACK_TOKEN_TTL_MS = 55 * 60_000;

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
