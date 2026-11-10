import http from 'node:http';
import { createApp } from '../src/app.js';

export const silentLogger = { info() {}, error() {} };

export function listen(server) {
  return new Promise((resolve, reject) => {
    const listener = server.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
}

export function urlFor(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

export function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export async function startProxy({ config, tokenProvider, logger = silentLogger }) {
  const app = createApp({ config, tokenProvider, logger });
  const server = await listen(app);
  return { server, baseUrl: urlFor(server), close: () => close(server) };
}

export async function startUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-upstream', 'yes');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(server);
  return { server, url: urlFor(server), requests, close: () => close(server) };
}

export function makeConfig(overrides = {}) {
  return {
    target: 'https://apigee.googleapis.com',
    port: 0,
    host: '127.0.0.1',
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    timeoutMs: 5000,
    allowedPathPrefixes: [],
    allowedMethods: [],
    basePath: '',
    verifyTls: true,
    logRequests: false,
    ...overrides,
  };
}
