import process from 'node:process';
import { loadConfig } from './config.js';
import { createAuthTokenProvider } from './auth.js';
import { createApp } from './app.js';

function main() {
  const config = loadConfig();
  const tokenProvider = createAuthTokenProvider({
    keyFile: config.keyFile,
    scopes: config.scopes,
    subject: config.subject,
    staticToken: config.staticToken,
  });

  const app = createApp({ config, tokenProvider });
  const server = app.listen(config.port, config.host, () => {
    console.log(`proxy listening on http://${config.host}:${config.port}`);
    const authLabel =
      tokenProvider.mode === 'static_token'
        ? 'a static access token'
        : tokenProvider.mode === 'service_account_with_static_fallback'
          ? 'a Google service account (STATIC_ACCESS_TOKEN as fallback)'
          : 'a Google service account';
    console.log(`forwarding to ${config.target} as ${authLabel}`);
    if (config.basePath) console.log(`mounted under ${config.basePath}`);
    if (config.allowedPathPrefixes.length) {
      console.log(`allowed path prefixes: ${config.allowedPathPrefixes.join(', ')}`);
    }
  });

  server.on('error', (err) => {
    console.error(`Failed to start proxy: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}
