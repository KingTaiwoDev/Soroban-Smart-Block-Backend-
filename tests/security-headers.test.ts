/**
 * Regression tests for security headers across API surfaces (#1236).
 *
 * Two layers:
 *  1. Behavioural — the production `securityHeaders()` middleware is mounted the
 *     way `createApp` mounts it (globally, first) in front of stand-ins for each
 *     surface: REST (/api/v1), GraphQL, billing, status, docs/OpenAPI, metrics,
 *     health probes, early proxy-header rejections, error and 404 responses.
 *  2. Structural — `src/app.ts` is scanned to make sure the middleware stays
 *     registered before every router/route, so a future refactor cannot mount
 *     a surface ahead of it unnoticed.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { securityHeaders } from '../src/middleware/securityHeaders';
import { rejectUntrustedForwardedHeaders } from '../src/middleware/proxyTrust';

function buildApp() {
  const app = express();
  app.set('trust proxy', false);
  app.use(securityHeaders());
  app.use(rejectUntrustedForwardedHeaders);
  app.use(express.json({ limit: '1mb' }));

  const v1 = express.Router();
  v1.get('/transactions', (_req, res) => res.json({ data: [] }));
  v1.post('/webhooks', (req, res) => res.status(201).json({ received: req.body }));
  v1.get('/boom', () => {
    throw new Error('boom');
  });

  app.get('/api/docs.json', (_req, res) => res.json({ openapi: '3.0.0' }));
  app.get('/api/v1/openapi.json', (_req, res) => res.json({ openapi: '3.0.0' }));
  app.use('/api/graphql', (_req, res) => res.json({ data: { __typename: 'Query' } }));
  app.use('/api/v1', v1);
  app.use('/api/billing', express.Router().get('/plans', (_req, res) => res.json([])));
  app.get('/metrics', (_req, res) => res.type('text/plain').send('# HELP up 1\n'));
  app.get('/health', (_req, res) => res.json({ status: 'healthy' }));
  app.get('/healthz', (_req, res) => res.json({ status: 'alive' }));
  app.get('/readyz', (_req, res) => res.status(503).json({ status: 'not_ready' }));
  app.use(
    '/status',
    express.Router().get('/', (_req, res) => res.json({ status: 'operational' })),
  );

  const errorHandler: express.ErrorRequestHandler = (_err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal Server Error' });
  };
  app.use(errorHandler);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

function expectSecurityHeaders(res: request.Response) {
  const csp = res.headers['content-security-policy'];
  expect(csp).toBeDefined();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers['strict-transport-security']).toBe(
    'max-age=31536000; includeSubDomains; preload',
  );
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(res.headers['x-download-options']).toBe('noopen');
  expect(res.headers['x-xss-protection']).toBe('0');
  expect(res.headers['x-powered-by']).toBeUndefined();
}

describe('security headers across API surfaces', () => {
  const app = buildApp();

  it.each([
    ['REST list endpoint', '/api/v1/transactions', 200],
    ['OpenAPI schema', '/api/v1/openapi.json', 200],
    ['legacy docs schema', '/api/docs.json', 200],
    ['GraphQL', '/api/graphql', 200],
    ['billing', '/api/billing/plans', 200],
    ['status page', '/status', 200],
    ['metrics', '/metrics', 200],
    ['health', '/health', 200],
    ['liveness probe', '/healthz', 200],
    ['readiness probe (failing)', '/readyz', 503],
  ])('%s (%s) returns the full header set', async (_name, url, status) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(status);
    expectSecurityHeaders(res);
  });

  it('applies headers to JSON POST bodies', async () => {
    const res = await request(app).post('/api/v1/webhooks').send({ url: 'https://example.com' });
    expect(res.status).toBe(201);
    expectSecurityHeaders(res);
  });

  it('applies headers to unhandled-error responses', async () => {
    const res = await request(app).get('/api/v1/boom');
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
  });

  it('applies headers to the 404 catch-all', async () => {
    const res = await request(app).get('/definitely/not/a/route');
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it('applies headers to malformed JSON rejections from the body parser', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectSecurityHeaders(res);
  });

  it('applies headers to early untrusted-proxy-header rejections', async () => {
    const res = await request(app).get('/api/v1/transactions').set('X-Forwarded-For', '10.0.0.1');
    expect(res.status).toBe(400);
    expectSecurityHeaders(res);
  });

});

describe('createApp mounts securityHeaders before every surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
  const body = source.slice(source.indexOf('export function createApp'));
  const mountIndex = body.indexOf('app.use(securityHeaders())');

  it('registers the middleware inside createApp', () => {
    expect(mountIndex).toBeGreaterThan(-1);
  });

  it('does not configure helmet inline (single source of truth)', () => {
    expect(source).not.toMatch(/from 'helmet'/);
  });

  it('registers it before every route, router mount and early-rejecting middleware', () => {
    const laterRegistrations = [
      /app\.(get|post|put|patch|delete|all)\(/g,
      /app\.use\(\s*['"[]/g,
      /app\.use\(rejectUntrustedForwardedHeaders\)/g,
      /app\.use\(\s*cors\(/g,
      /app\.use\(express\.json/g,
      /app\.use\(errorHandler\)/g,
    ];
    for (const pattern of laterRegistrations) {
      for (const match of body.matchAll(pattern)) {
        const where = `${match[0]} must be registered after securityHeaders()`;
        expect(match.index, where).toBeGreaterThan(mountIndex);
      }
    }
  });
});
