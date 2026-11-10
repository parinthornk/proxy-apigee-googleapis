# proxy-apigee-googleapis

A small HTTP reverse proxy that forwards requests to `https://apigee.googleapis.com` and authenticates with a Google service account. Clients call the proxy without credentials; the proxy obtains a Google OAuth2 access token from the service account JSON key and adds it as a `Bearer` token on every upstream request.

## How authentication works

1. On startup the proxy loads the service account JSON key.
2. On the first request it signs a JWT assertion with the key's private key (scope from `GOOGLE_SCOPES`, default `https://www.googleapis.com/auth/cloud-platform`).
3. It exchanges the assertion for an access token at Google's `oauth2.googleapis.com/token` endpoint.
4. The token is cached in memory until it nears expiry (60 s skew) and shared by concurrent requests.
5. Every forwarded request has its `Authorization` header replaced with `Bearer <access token>`; any client-supplied `Authorization` is discarded.

## Requirements

- Node.js 20.19+ (uses `--env-file-if-exists`)
- A Google service account with permission to call the Apigee API, and its JSON key

## Setup

```powershell
npm install
Copy-Item .env.example .env
# edit .env and point GOOGLE_APPLICATION_CREDENTIALS at your key file
```

The key file is read directly, so `GOOGLE_APPLICATION_CREDENTIALS` can also point at a file outside the repo. Keep it out of Git (`.gitignore` already covers common names under `secrets/`).

## Run

```powershell
npm start
# or with file watching
npm run dev
```

Then call the proxy with the same path you would call on Apigee:

```powershell
curl.exe http://127.0.0.1:8080/v1/organizations/YOUR_ORG/apis
curl.exe http://127.0.0.1:8080/healthz
```

Example output for `healthz`:

```json
{ "status": "ok", "target": "https://apigee.googleapis.com" }
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` / `SA_KEY_FILE` | required | Path to the service account JSON key |
| `TARGET_URL` | `https://apigee.googleapis.com` | Upstream base URL; must be HTTPS unless `ALLOW_INSECURE_TARGET=true` |
| `HOST` | `127.0.0.1` | Listen address; use `0.0.0.0` when running in a container |
| `PORT` | `8080` | Listen port |
| `GOOGLE_SCOPES` | `https://www.googleapis.com/auth/cloud-platform` | Comma-separated OAuth2 scopes |
| `GOOGLE_IMPERSONATE_SUBJECT` | unset | Optional `sub` claim for domain-wide delegation |
| `BASE_PATH` | unset | Mount path; the prefix is stripped before forwarding (e.g. `/apigee` turns `/apigee/v1/...` into `/v1/...`) |
| `ALLOWED_PATH_PREFIXES` | unset (all paths) | Comma-separated path prefixes the proxy will forward; others get `403`. A `*` matches a single path segment, e.g. `/v1/organizations/*/apis` |
| `ALLOWED_METHODS` | unset (all methods) | Comma-separated HTTP methods the proxy will forward; others get `405` with an `Allow` header, e.g. `GET` |
| `PROXY_TIMEOUT_MS` | `60000` | Upstream connect/response timeout |
| `TARGET_TLS_VERIFY` | `true` | Set to `false` to skip TLS verification (not recommended) |
| `LOG_REQUESTS` | `true` | Log forwarded requests and upstream status codes |
| `ALLOW_INSECURE_TARGET` | `false` | Permit a plaintext `http://` target for local testing only |

### Restricting to read-only API proxy, deployment and target server access

To let callers only read API proxies, API products, deployments and target servers (GET only), set:

```
ALLOWED_METHODS=GET
ALLOWED_PATH_PREFIXES=/v1/organizations/*/apis,/v1/organizations/*/apiproducts,/v1/organizations/*/deployments,/v1/organizations/*/environments/*/deployments,/v1/organizations/*/environments/*/apis/*/deployments,/v1/organizations/*/environments/*/apis/*/revisions/*/deployments,/v1/organizations/*/environments/*/targetservers
```

This forwards:

- `GET /v1/organizations/<org>/apis...` - proxies and revisions, including bundle downloads via `.../apis/<api>/revisions/<rev>?format=bundle`
- `GET /v1/organizations/<org>/apiproducts...`
- `GET /v1/organizations/<org>/deployments` and `.../deployments/...`
- `GET /v1/organizations/<org>/environments/<env>/deployments...`
- `GET /v1/organizations/<org>/environments/<env>/apis/<api>/deployments...` and `.../revisions/<rev>/deployments...`
- `GET /v1/organizations/<org>/environments/<env>/targetservers` and `.../targetservers/<name>`

Everything else is rejected: other methods get `405`, other paths (apps, developers, environments, etc.) get `403`. The `*` matches exactly one path segment, so the org, environment and resource names are not hardcoded.

Proxy bundles are streamed through unmodified, so `?format=bundle` downloads keep their `application/octet-stream` body. If large bundles exceed the default timeout, raise `PROXY_TIMEOUT_MS`.

## Testing

```powershell
npm test
```

The suite uses Node's built-in test runner and does not call Google. It starts a fake upstream to verify path/query/body/header forwarding, token injection, allowlists, base-path stripping, `502` handling, and token caching/refresh.

## Security notes

- The proxy has no authentication of its own. Bind it to `127.0.0.1` or put it behind your platform's auth. Use `ALLOWED_PATH_PREFIXES` to limit blast radius.
- Never commit the service account JSON; rotate the key if it leaks.
- The access token is cached in process memory only and never written to disk.
- `TARGET_URL` defaults to HTTPS and plaintext targets are rejected unless explicitly allowed.

## Project layout

```
src/config.js   environment parsing and validation
src/auth.js     service account loading, JWT signing, token exchange and cache
src/app.js      Express app, auth injection, path filters, proxy middleware
src/server.js   startup and graceful shutdown
test/           unit and integration tests (fake upstream)
test-utils/     shared test helpers
```

## Live verification

The tests above are local/mocked. To verify against Google, set a real key and run:

```powershell
npm start
curl.exe -i http://127.0.0.1:8080/v1/organizations/YOUR_ORG
```

A `200`/`403` from Apigee (rather than `502`) means authentication succeeded; `502` with `auth_failed` means the token exchange failed.
