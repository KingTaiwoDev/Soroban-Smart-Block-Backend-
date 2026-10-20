import { Request, Response, NextFunction } from 'express';
import {
  apiSloRequestDuration,
  apiSloRequestsTotal,
  httpRequestDuration,
  httpRequestTotal,
} from '../metrics';
import { normaliseRouteLabel } from '../lib/metric-labels';

export type ApiEndpointClass = 'read' | 'write' | 'compute' | 'graphql';
export type ApiSloOutcome = 'good' | 'bad' | 'excluded';

const COMPUTE_ENDPOINTS =
  /^\/api\/v\d+\/(?:simulate|verify|compiler|sandbox|aa|reentrancy|composability|mev|privacy|fraud|dex\/analyze)(?:\/|$)/;

export function classifyApiEndpoint(path: string, method: string): ApiEndpointClass | null {
  if (/^\/api\/graphql(?:\/|$)/.test(path)) return 'graphql';
  if (!path.startsWith('/api/')) return null;
  if (COMPUTE_ENDPOINTS.test(path)) return 'compute';
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

export function classifyApiSloOutcome(statusCode: number): ApiSloOutcome {
  if (statusCode >= 200 && statusCode < 400) return 'good';
  if (statusCode >= 500) return 'bad';
  return 'excluded';
}

/**
 * Express middleware that records HTTP request duration and total count
 * using Prometheus histograms/counters.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start: bigint = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSeconds: number = Number(process.hrtime.bigint() - start) / 1e9;
    // Normalise dynamic path segments and strip account/contract identifiers so
    // they never become label values (high cardinality + data leak, #1241).
    const route: string = normaliseRouteLabel(req.route?.path ?? req.path);
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestTotal.inc(labels);

    const endpointClass = classifyApiEndpoint(req.path, req.method);
    if (endpointClass !== null) {
      const outcome = classifyApiSloOutcome(res.statusCode);
      const sloLabels = { endpoint_class: endpointClass, outcome };
      apiSloRequestsTotal.inc(sloLabels);
      apiSloRequestDuration.observe(sloLabels, durationSeconds);
    }
  });

  next();
}
