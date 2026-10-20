/**
 * Enterprise Global Error Handler
 *
 * Catches all unhandled errors in Express middleware and route handlers.
 * Returns structured JSON responses with correlation IDs, error classification,
 * recovery hints, and integrates with monitoring/alerting.
 *
 * Mount AFTER all routes but BEFORE the 404 catch-all:
 * app.use(errorHandler);
 * app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
 */

import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { config } from '../config';
import { httpErrorsTotal } from '../metrics';
import { normaliseRouteLabel } from '../lib/metric-labels';
import {
  type ErrorCode,
  type StructuredErrorResponse,
  type RecoveryHint,
  classifyError,
  buildRecoveryHint,
} from '../types/errors';
import {
  redactSensitiveText,
  redactSensitiveObject,
  createErrorFingerprint,
} from '../utils/structuredErrorReporter';

/* ─── AppError (backward-compatible) ─────────────────────────────────────── */

export class AppError extends Error {
  statusCode: number;
  code: ErrorCode;

  constructor(statusCode: number, message: string, code?: ErrorCode) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code ?? 'VALIDATION_ERROR';
  }
}

/* ─── Extended error classes for classification ──────────────────────────── */

export class ValidationError extends AppError {
  details?: Array<{ field: string; issue: string }>;

  constructor(message: string, details?: Array<{ field: string; issue: string }>) {
    super(400, message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, message, 'AUTH_ERROR');
    this.name = 'ForbiddenError';
  }
}

export class AuthError extends AppError {
  constructor(message: string) {
    super(401, message, 'AUTH_ERROR');
    this.name = 'AuthError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends AppError {
  retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(429, message, 'RATE_LIMITED');
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ExternalError extends AppError {
  constructor(message: string) {
    super(502, message, 'EXTERNAL_SERVICE_ERROR');
    this.name = 'ExternalError';
  }
}

/* ─── Rate-limited error logging (prevents log floods) ───────────────────── */

interface LogBucket {
  count: number;
  windowStart: number;
}

const LOG_RATE_LIMIT = 10; // max errors per minute per error code
const LOG_WINDOW_MS = 60_000;

const errorLogBuckets = new Map<string, LogBucket>();

function shouldLogError(code: string): boolean {
  const now = Date.now();
  const bucket = errorLogBuckets.get(code);

  if (!bucket || now - bucket.windowStart > LOG_WINDOW_MS) {
    errorLogBuckets.set(code, { count: 1, windowStart: now });
    return true;
  }

  if (bucket.count < LOG_RATE_LIMIT) {
    bucket.count++;
    return true;
  }

  return false;
}

/* ─── Main error handler ─────────────────────────────────────────────────── */

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const classification = classifyError(err);
  const statusCode = (err as AppError).statusCode ?? classification.statusCode;
  const code = (err as AppError).code ?? classification.code;

  // Request context
  const requestId = req.requestId ?? 'unknown';
  const startedAt = req.startedAt ?? Date.now();
  const durationMs = Date.now() - startedAt;

  // Recovery hints
  let recovery: RecoveryHint | undefined = buildRecoveryHint(err, classification);

  // Override recovery for RateLimitError (has explicit retryAfter)
  if (err instanceof RateLimitError) {
    recovery = {
      message: 'Rate limit exceeded. Please retry after the specified time.',
      retryAfter: err.retryAfter,
    };
    res.setHeader('Retry-After', String(err.retryAfter));
  }

  // Extract details for ValidationError
  let details: Array<{ field: string; issue: string }> | undefined = undefined;
  if (err instanceof ValidationError && err.details) {
    details = err.details;
  } else {
    const maybeDetails = (err as unknown as { details?: unknown }).details;
    if (Array.isArray(maybeDetails)) {
      details = maybeDetails as Array<{ field: string; issue: string }>;
    }
  }

  const rawMessage =
    config.nodeEnv !== 'production' || err instanceof AppError
      ? err.message || 'Internal Server Error'
      : statusCode < 500
        ? err.message || 'Bad request'
        : 'Internal Server Error';

  const sanitizedMessage = redactSensitiveText(rawMessage);
  const sanitizedStack = err.stack ? redactSensitiveText(err.stack) : undefined;
  const fingerprint = createErrorFingerprint(code, sanitizedMessage, err.stack);
  const errorId = (req as unknown as { errorId?: string }).errorId ?? randomUUID();

  const errorObj: StructuredErrorResponse['error'] = {
    code,
    message: sanitizedMessage,
  };

  if (details) {
    errorObj.details = redactSensitiveObject(
      details as unknown as Record<string, unknown>,
    ) as unknown as Array<{ field: string; issue: string }>;
  }

  if (config.nodeEnv === 'development') {
    errorObj.stack = sanitizedStack;
  }

  if (recovery) {
    errorObj.recovery = recovery;
  }

  // Build structured response
  const responseBody: StructuredErrorResponse = {
    success: false,
    error: errorObj,
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
      fingerprint,
      errorId,
    },
  };

  // Structured logging
  const rawLogMeta: Record<string, unknown> = {
    requestId,
    errorId,
    fingerprint,
    code,
    statusCode,
    severity: classification.severity,
    error: redactSensitiveText(err.message),
    method: req.method,
    endpoint: req.path,
    route: normaliseRouteLabel(req.path),
    durationMs,
    userAgent: req.headers['user-agent'],
    ip: (req.ip ?? req.socket?.remoteAddress ?? '').replace('::ffff:', ''),
  };

  // Add auth context when available
  if (req.user) {
    rawLogMeta.userId = req.user.id;
    rawLogMeta.userRole = req.user.role;
    rawLogMeta.userTier = req.user.tier;
  }

  if (req.apiKey) {
    rawLogMeta.apiKeyId = req.apiKey.id;
    rawLogMeta.apiKeyTier = req.apiKey.tier;
  }

  const logMeta = redactSensitiveObject(rawLogMeta);

  // Rate-limited logging
  if (shouldLogError(code)) {
    if (statusCode >= 500) {
      logger.error('Unhandled server error', logMeta);
    } else {
      logger.warn('Request error', logMeta);
    }
  } else {
    // Still log at debug level so we don't lose visibility entirely
    logger.debug('Error (rate-limited logging)', {
      requestId,
      errorId,
      fingerprint,
      code,
      error: redactSensitiveText(err.message),
    });
  }

  // Prometheus metrics
  httpErrorsTotal.inc({
    code,
    severity: classification.severity,
    route: normaliseRouteLabel(req.path),
  });

  // Send response
  // Always echo the correlation ID as a header so clients can correlate
  // error responses with logs even if they only read headers. (#891)
  if (!res.headersSent) {
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Error-Fingerprint', fingerprint);
  }
  res.status(statusCode).json(responseBody);
} // <--- Closes the errorHandler function properly

/** Any error that carries a numeric statusCode is treated as an HTTP error. */
function _hasStatusCode(err: unknown): err is { statusCode: number; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as Record<string, unknown>).statusCode === 'number'
  );
}
