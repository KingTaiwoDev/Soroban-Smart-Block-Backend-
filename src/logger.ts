import { traceStorage } from './middleware/correlation';
import { trace } from '@opentelemetry/api';
import { redactSensitiveText, redactSensitiveObject } from './utils/structuredErrorReporter';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
const IS_PROD = process.env.NODE_ENV === 'production';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  ledgerSequence?: number;
  [key: string]: unknown;
}

/**
 * Anything that can be attached to a log line as structured context.
 * Call sites legitimately pass plain objects, but also strings, numbers,
 * Errors and typed interfaces (which lack an index signature) — accepting
 * `unknown` avoids forcing every caller to wrap its value.
 */
type LogMeta = unknown;

/**
 * Normalise the context argument into a plain object that can be spread into
 * the JSON log entry. Primitive values are nested under `detail`; `Error`
 * instances keep their message and stack.
 */
function toMeta(meta: LogMeta): Record<string, unknown> {
  if (meta === undefined || meta === null) return {};
  if (meta instanceof Error) {
    return { error: meta.message, ...(meta.stack ? { stack: meta.stack } : {}) };
  }
  if (typeof meta === 'object' && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  return { detail: meta };
}

function log(level: LogLevel, message: string | Record<string, unknown>, meta?: LogMeta): void {
  const messageText = redactSensitiveText(
    typeof message === 'string' ? message : String(message.message ?? safeJson(message)),
  );

  const rawMeta =
    typeof message === 'string' ? toMeta(meta) : toMeta({ ...message, ...toMeta(meta) });
  const metaObj = redactSensitiveObject(rawMeta);

  const ctx = traceStorage.getStore();
  const activeSpanContext = trace.getActiveSpan()?.spanContext();
  const entry: LogEntry = {
    level,
    message: messageText,
    timestamp: new Date().toISOString(),
    ...metaObj,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(activeSpanContext?.traceId || ctx?.traceId
      ? { traceId: activeSpanContext?.traceId || ctx?.traceId }
      : {}),
    ...(activeSpanContext?.spanId || ctx?.spanId
      ? { spanId: activeSpanContext?.spanId || ctx?.spanId }
      : {}),
    ...(ctx?.ledgerSequence !== undefined ? { ledgerSequence: ctx.ledgerSequence } : {}),
  };

  const line = IS_PROD ? JSON.stringify(entry) : prettyPrint(entry);

  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function prettyPrint(e: Record<string, unknown>): string {
  const { level, timestamp, message, ...rest } = e;
  const extras = Object.keys(rest).length ? ' ' + safeJson(rest) : '';
  return `[${String(timestamp).slice(11, 23)}] ${String(level).toUpperCase().padEnd(5)} ${message}${extras}`;
}

// ---------------------------------------------------------------------------
// Component logger — `new Logger('ComponentName')` for modules that want a
// stable component label on every line without threading it through each call.
// ---------------------------------------------------------------------------
export class Logger {
  private readonly component: string;

  constructor(component: string) {
    this.component = component;
  }

  debug(msg: string | Record<string, unknown>, meta?: LogMeta): void {
    log('debug', msg, { component: this.component, ...toMeta(meta) });
  }

  info(msg: string | Record<string, unknown>, meta?: LogMeta): void {
    log('info', msg, { component: this.component, ...toMeta(meta) });
  }

  warn(msg: string | Record<string, unknown>, meta?: LogMeta): void {
    log('warn', msg, { component: this.component, ...toMeta(meta) });
  }

  error(msg: string | Record<string, unknown>, meta?: LogMeta): void {
    log('error', msg, { component: this.component, ...toMeta(meta) });
  }
}

// ---------------------------------------------------------------------------
// Exported logger
// ---------------------------------------------------------------------------
export const logger = {
  debug: (msg: string | Record<string, unknown>, meta?: LogMeta) => log('debug', msg, meta),
  info: (msg: string | Record<string, unknown>, meta?: LogMeta) => log('info', msg, meta),
  warn: (msg: string | Record<string, unknown>, meta?: LogMeta) => log('warn', msg, meta),
  error: (msg: string | Record<string, unknown>, meta?: LogMeta) => log('error', msg, meta),
};

// ---------------------------------------------------------------------------
// Express enrichment middleware — attach request ID + duration to each log
// ---------------------------------------------------------------------------
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
  const currentContext = traceStorage.getStore();
  const start = Date.now();

  res.setHeader('x-request-id', requestId);

  traceStorage.run(
    {
      requestId,
      traceId: currentContext?.traceId ?? '',
      spanId: currentContext?.spanId ?? '',
    },
    () => {
      res.on('finish', () => {
        logger.info('request completed', {
          method: req.method,
          route: req.route?.path ?? req.path,
          status: res.statusCode,
          duration_ms: Date.now() - start,
        });
      });
      next();
    },
  );
}
