/**
 * Structured Error Reporting with Sensitive-Field Redaction
 *
 * Provides deep redaction of sensitive credentials, tokens, Stellar secret keys,
 * connection strings, and PII from error messages, stack traces, and metadata.
 * Generates deterministic error fingerprints for deduplication and structured telemetry.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ErrorCode, ErrorClassification } from '../types/errors';
import { classifyError } from '../types/errors';

export const REDACTED_MARKER = '[REDACTED]';

/**
 * Common regex patterns for secrets and credentials across the codebase.
 */
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  // Stellar secret seed keys (S followed by 55 base32 chars)
  /\bS[A-Z2-7]{55}\b/g,

  // Bearer tokens and Authorization headers
  /(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /(?:authorization|x-api-key|x-auth-token)\s*[:=]\s*["']?([^\s"',;}\]]+)/gi,

  // JWT tokens (three base64url segments)
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,

  // OpenAI / Anthropic / AWS API keys
  /\bsk-[a-zA-Z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,

  // Generic key/password assignments in text
  /(?:password|passwd|pwd|secret|api[_-]?key|private[_-]?key|passphrase)\s*[:=]\s*["']?([^\s"',;}\]]+)/gi,

  // PEM Private keys
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,

  // 64-char Hex private keys
  /\b0x[a-fA-F0-9]{64}\b/g,

  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

/**
 * Case-insensitive set of object property keys whose values must always be redacted.
 */
export const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'bearer',
  'apikey',
  'api_key',
  'auth',
  'authorization',
  'cookie',
  'set-cookie',
  'seed',
  'privatekey',
  'private_key',
  'credential',
  'databaseurl',
  'database_url',
  'adminapikey',
  'admin_api_key',
  'jwtsecret',
  'jwt_secret',
  'wssecret',
  'ws_secret',
  'webhooksecret',
  'webhook_secret',
  'access_token',
  'refresh_token',
  'passphrase',
  'secretkey',
  'secret_key',
]);

/**
 * Redacts known secret patterns from arbitrary string text.
 */
export function redactSensitiveText(text: string | null | undefined): string {
  if (!text || typeof text !== 'string') {
    return text ?? '';
  }

  let sanitized = text;

  // Mask database credentials while preserving host and database name:
  // e.g. postgresql://user:pass@db.example.com/soroban -> postgresql://user:[REDACTED]@db.example.com/soroban
  sanitized = sanitized.replace(
    /(?:postgresql|postgres|mysql|mongodb|redis|sentinel):\/\/([^:@/\s]+):([^@/\s]+)@/gi,
    (match, _user) =>
      match.replace(`:${match.split(':')[2].split('@')[0]}@`, `:${REDACTED_MARKER}@`),
  );

  // Apply other credential patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith('bearer ')) {
        return `Bearer ${REDACTED_MARKER}`;
      }
      return REDACTED_MARKER;
    });
  }

  return sanitized;
}

/**
 * Recursively redacts sensitive object keys and values with circular reference protection.
 */
export function redactSensitiveObject<T>(input: T, maxDepth = 10, seen = new WeakSet()): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    return redactSensitiveText(input) as unknown as T;
  }

  if (typeof input !== 'object') {
    return input;
  }

  if (seen.has(input)) {
    return '[Circular]' as unknown as T;
  }
  seen.add(input);

  if (maxDepth <= 0) {
    return '[MaxDepthExceeded]' as unknown as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveObject(item, maxDepth - 1, seen)) as unknown as T;
  }

  if (input instanceof Error) {
    const errorObj: Record<string, unknown> = {
      name: input.name,
      message: redactSensitiveText(input.message),
      stack: input.stack ? redactSensitiveText(input.stack) : undefined,
    };
    for (const [key, val] of Object.entries(input)) {
      if (SENSITIVE_KEY_NAMES.has(key.toLowerCase().replace(/[-_]/g, ''))) {
        errorObj[key] = REDACTED_MARKER;
      } else {
        errorObj[key] = redactSensitiveObject(val, maxDepth - 1, seen);
      }
    }
    return errorObj as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
    if (SENSITIVE_KEY_NAMES.has(normalizedKey)) {
      result[key] = REDACTED_MARKER;
    } else {
      result[key] = redactSensitiveObject(value, maxDepth - 1, seen);
    }
  }

  return result as T;
}

/**
 * Computes a deterministic error fingerprint for aggregation and alert deduplication.
 */
export function createErrorFingerprint(code: string, message: string, stack?: string): string {
  // Normalize dynamic numbers, UUIDs, and timestamps from the message
  const normalizedMessage = message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<TIMESTAMP>')
    .replace(/\b\d+\b/g, '<NUM>')
    .trim()
    .toLowerCase();

  // Extract top stack frame location without line numbers
  let topFrame = '';
  if (stack) {
    const lines = stack.split('\n');
    for (const line of lines.slice(1, 4)) {
      if (line.includes('at ') && !line.includes('node_modules')) {
        topFrame = line.replace(/:\d+:\d+/g, '').trim();
        break;
      }
    }
  }

  const hash = createHash('sha256');
  hash.update(`${code}|${normalizedMessage}|${topFrame}`);
  return hash.digest('hex').slice(0, 16);
}

export interface ErrorReportContext {
  service?: string;
  network?: string;
  component?: string;
  route?: string;
  method?: string;
  requestId?: string;
  traceId?: string;
  durationMs?: number;
}

export interface StructuredErrorReport {
  errorId: string;
  timestamp: string;
  code: ErrorCode;
  statusCode: number;
  severity: ErrorClassification['severity'];
  message: string;
  fingerprint: string;
  stack?: string;
  context: ErrorReportContext;
  metadata?: Record<string, unknown>;
}

/**
 * Builds a sanitized, structured error report from any error object or exception.
 */
export function reportStructuredError(
  err: unknown,
  context: ErrorReportContext = {},
  metadata?: Record<string, unknown>,
): StructuredErrorReport {
  const errorObj = err instanceof Error ? err : new Error(String(err));
  const classification = classifyError(errorObj);
  const errorRecord =
    typeof errorObj === 'object' && errorObj !== null ? (errorObj as Record<string, unknown>) : {};
  const statusCode =
    typeof errorRecord.statusCode === 'number' ? errorRecord.statusCode : classification.statusCode;
  const code = typeof errorRecord.code === 'string' ? errorRecord.code : classification.code;

  const errorId = randomUUID();
  const timestamp = new Date().toISOString();

  const sanitizedMessage = redactSensitiveText(errorObj.message || 'An error occurred');
  const sanitizedStack = errorObj.stack ? redactSensitiveText(errorObj.stack) : undefined;
  const fingerprint = createErrorFingerprint(code, sanitizedMessage, sanitizedStack);

  const sanitizedContext: ErrorReportContext = {
    service: context.service ?? 'soroban-explorer-backend',
    network: context.network ?? process.env.STELLAR_NETWORK ?? 'testnet',
    ...redactSensitiveObject(context),
  };

  const sanitizedMetadata = metadata ? redactSensitiveObject(metadata) : undefined;

  return {
    errorId,
    timestamp,
    code,
    statusCode,
    severity: classification.severity,
    message: sanitizedMessage,
    fingerprint,
    stack: sanitizedStack,
    context: sanitizedContext,
    metadata: sanitizedMetadata,
  };
}
