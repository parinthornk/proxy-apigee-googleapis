import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePathMatchers(prefixes) {
  return prefixes.map((prefix) => {
    const body = escapeRegExp(prefix).replace(/\\\*/g, '[^/]+');
    return new RegExp(`^${body}(?:/.*)?$`);
  });
}

function stripBasePath(pathname, basePath) {
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return pathname;
}

export function createApp({ config, tokenProvider, logger = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', target: config.target });
  });

  const allowedMethods = new Set(
    (config.allowedMethods ?? []).map((method) => method.toUpperCase()),
  );
  const pathMatchers = compilePathMatchers(config.allowedPathPrefixes ?? []);
  const methodPathRules = (config.allowedMethodPaths ?? []).map(({ method, path }) => ({
    method,
    matcher: compilePathMatchers([path])[0],
  }));

  function allowedMethodsFor(pathname) {
    const methods = new Set(allowedMethods);
    for (const rule of methodPathRules) {
      if (rule.matcher.test(pathname)) methods.add(rule.method);
    }
    return methods;
  }

  app.use((req, res, next) => {
    const pathname = stripBasePath(req.originalUrl.split('?')[0], config.basePath);
    const method = req.method.toUpperCase();

    if (allowedMethods.size > 0) {
      const methods = [...allowedMethodsFor(pathname)];
      if (!methods.includes(method)) {
        res.setHeader('Allow', methods.join(', '));
        res.status(405).json({
          error: 'method_not_allowed',
          message: 'The requested HTTP method is not allowed.',
          allowedMethods: methods,
        });
        return;
      }
    }

    if (pathMatchers.length > 0) {
      if (!pathMatchers.some((matcher) => matcher.test(pathname))) {
        const methodRuleMatches = methodPathRules.some(
          (rule) => rule.method === method && rule.matcher.test(pathname),
        );
        res.status(403).json({
          error: 'path_not_allowed',
          message: 'The requested path is not in ALLOWED_PATH_PREFIXES.',
          allowedPrefixes: config.allowedPathPrefixes,
          ...(methodRuleMatches && {
            hint: `ALLOWED_METHOD_PATHS allows ${method} on this path, but the path is not covered by ALLOWED_PATH_PREFIXES.`,
          }),
        });
        return;
      }
    }

    next();
  });

  app.use(async (req, res, next) => {
    try {
      req.proxyAuthorization = await tokenProvider.getAuthorizationHeader();
      next();
    } catch (err) {
      logger.error(`Failed to obtain a Google access token: ${err.message}`);
      res.status(502).json({
        error: 'auth_failed',
        message: 'Could not obtain a Google access token from the service account credentials.',
      });
    }
  });

  const proxy = createProxyMiddleware({
    target: config.target,
    changeOrigin: true,
    xfwd: true,
    secure: config.verifyTls !== false,
    timeout: config.timeoutMs,
    proxyTimeout: config.timeoutMs,
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('authorization', req.proxyAuthorization);
        proxyReq.removeHeader('proxy-authorization');

        if (config.logRequests) {
          logger.info?.(`--> ${req.method} ${req.originalUrl} -> ${config.target}${req.url}`);
        }
      },
      proxyRes: (proxyRes, req) => {
        if (config.logRequests) {
          logger.info?.(`<-- ${proxyRes.statusCode} ${req.method} ${req.originalUrl}`);
        }
      },
      error: (err, req, res) => {
        logger.error(`Upstream request failed for ${req.method} ${req.originalUrl}: ${err.message}`);
        if (!res || res.headersSent) {
          res?.end();
          return;
        }
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            error: 'upstream_error',
            message: `The request to ${config.target} failed.`,
          }),
        );
      },
    },
  });

  app.use(config.basePath || '/', proxy);

  app.use((err, _req, res, _next) => {
    logger.error(`Unhandled proxy error: ${err.message}`);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
