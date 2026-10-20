/**
 * Webhook signature verification utilities (issues #884, #1239)
 *
 * Provides:
 *  1. Constant-time HMAC-SHA256 signature verification via crypto.timingSafeEqual.
 *  2. Timestamp-skew window — rejects payloads whose X-Webhook-Timestamp is
 *     outside TIMESTAMP_TOLERANCE_MS of the server clock to limit replay windows.
 *  3. In-process replay cache — remembers the nonce (timestamp+signature) of
 *     every accepted request for the duration of the skew window so that an
 *     attacker who captures a valid request cannot replay it even within the
 *     skew window.
 *
 * Outbound headers (built by `buildWebhookSignatureHeaders`):
 *   X-Webhook-Timestamp:    <unix-epoch-ms>
 *   X-Webhook-Signature-V2: sha256=<hex HMAC of "<timestamp>.<raw body>">
 *   X-Webhook-Signature:    sha256=<hex HMAC of the raw body>   (legacy, deprecated)
 *
 * The v2 signature binds the timestamp to the body, so a captured request
 * cannot be replayed with a fresh X-Webhook-Timestamp. The legacy header does
 * not cover the timestamp and is kept only so existing consumers keep
 * working; see docs/webhook-subscriptions.md for the migration path.
 *
 * Usage (inbound webhook handler):
 *   import { verifyTimestampedWebhookSignature } from '../webhooks/webhookVerify';
 *   const result = verifyTimestampedWebhookSignature(
 *     rawBody, secret, req.get('X-Webhook-Signature-V2'), req.get('X-Webhook-Timestamp'),
 *   );
 *   if (!result.ok) return res.status(401).json({ error: result.reason });
 */

import crypto from 'crypto';

// ── Configuration ─────────────────────────────────────────────────────────────

/** How far (ms) the sender's timestamp may drift from our clock. */
export const TIMESTAMP_TOLERANCE_MS =
  Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_MS ?? '') || 5 * 60 * 1000; // 5 minutes

/** Replay cache TTL — must cover the full tolerance window (plus some slack). */
const REPLAY_CACHE_TTL_MS = TIMESTAMP_TOLERANCE_MS * 2 + 10_000;

/** Maximum number of nonces to keep in the replay cache. */
const REPLAY_CACHE_MAX = 100_000;

// ── Replay cache ──────────────────────────────────────────────────────────────

/** Map<nonce, expiresAt>. Nonce = `${timestampMs}:${signatureHex}` */
const replayCache = new Map<string, number>();

/** Periodically evict expired nonces to keep memory bounded. */
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiresAt] of replayCache.entries()) {
    if (expiresAt < now) replayCache.delete(nonce);
  }
}, 60_000);

function isReplay(nonce: string): boolean {
  return replayCache.has(nonce);
}

function recordNonce(nonce: string, ttlMs: number = REPLAY_CACHE_TTL_MS): void {
  if (replayCache.size >= REPLAY_CACHE_MAX) {
    // Evict oldest entry (Map preserves insertion order).
    const firstKey = replayCache.keys().next().value;
    if (firstKey !== undefined) replayCache.delete(firstKey);
  }
  replayCache.set(nonce, Date.now() + ttlMs);
}

// ── Header names ──────────────────────────────────────────────────────────────

export const WEBHOOK_TIMESTAMP_HEADER = 'X-Webhook-Timestamp';
/** Timestamp-bound signature (#1239). */
export const WEBHOOK_SIGNATURE_V2_HEADER = 'X-Webhook-Signature-V2';
/** @deprecated Body-only signature; does not cover the timestamp. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Webhook-Signature';

// ── Core verification logic ───────────────────────────────────────────────────

export interface VerifyResult {
  ok: true;
  signatureHex: string;
}

export interface VerifyFailure {
  ok: false;
  reason: string;
}

/**
 * Verify an inbound webhook signature (legacy body-only scheme).
 *
 * @deprecated The timestamp is not covered by this signature, so the skew
 * check can be bypassed by rewriting X-Webhook-Timestamp. Use
 * `verifyTimestampedWebhookSignature` with X-Webhook-Signature-V2.
 *
 * @param rawBody        - The raw request body (Buffer or string).
 * @param secret         - The shared signing secret (plaintext).
 * @param signatureHeader - Value of X-Webhook-Signature (e.g. "sha256=abc123").
 * @param timestampHeader - Value of X-Webhook-Timestamp (unix epoch ms, as string).
 *                          Pass undefined to skip skew check (not recommended for production).
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  secret: string,
  signatureHeader: string | undefined,
  timestampHeader?: string | undefined,
): VerifyResult | VerifyFailure {
  // ── 1. Timestamp skew check ──────────────────────────────────────────────
  let timestampMs: number | undefined;

  if (timestampHeader !== undefined) {
    timestampMs = Number(timestampHeader);

    if (!Number.isFinite(timestampMs)) {
      return { ok: false, reason: 'X-Webhook-Timestamp is not a valid number' };
    }

    const skew = Math.abs(Date.now() - timestampMs);
    if (skew > TIMESTAMP_TOLERANCE_MS) {
      return {
        ok: false,
        reason: `Request timestamp is outside the ${TIMESTAMP_TOLERANCE_MS}ms tolerance window (skew: ${skew}ms)`,
      };
    }
  }

  // ── 2. Signature format check ────────────────────────────────────────────
  if (!signatureHeader) {
    return { ok: false, reason: 'Missing X-Webhook-Signature header' };
  }

  // Accept "sha256=<hex>" format (64 hex chars) or bare hex (legacy).
  const hexMatch = signatureHeader.match(/^(?:sha256=)?([0-9a-f]{64})$/i);
  if (!hexMatch) {
    return { ok: false, reason: 'Malformed X-Webhook-Signature header (expected sha256=<hex64>)' };
  }

  const receivedHex = hexMatch[1].toLowerCase();

  // ── 3. HMAC computation ──────────────────────────────────────────────────
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody as string, 'utf8');
  const expectedBuf = crypto.createHmac('sha256', secret).update(bodyBuf).digest();
  const receivedBuf = Buffer.from(receivedHex, 'hex');

  // Constant-time comparison — both buffers are always 32 bytes.
  const isValid = crypto.timingSafeEqual(expectedBuf, receivedBuf);

  if (!isValid) {
    return { ok: false, reason: 'Signature mismatch' };
  }

  // ── 4. Replay check ──────────────────────────────────────────────────────
  // Only perform replay detection when a timestamp is provided (nonce = ts+sig).
  if (timestampMs !== undefined) {
    const nonce = `${timestampMs}:${receivedHex}`;
    if (isReplay(nonce)) {
      return { ok: false, reason: 'Replayed request (nonce already seen)' };
    }
    recordNonce(nonce);
  }

  return { ok: true, signatureHex: receivedHex };
}

/**
 * Compute the outbound webhook signature for a given body and secret.
 * Returns the value to put in X-Webhook-Signature.
 */
export function signWebhookBody(body: Buffer | string, secret: string): string {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body as string, 'utf8');
  const hex = crypto.createHmac('sha256', secret).update(bodyBuf).digest('hex');
  return `sha256=${hex}`;
}

const SIGNATURE_RE = /^(?:sha256=)?([0-9a-f]{64})$/i;
const TIMESTAMP_RE = /^\d{1,16}$/;

function timestampedHmac(body: Buffer | string, secret: string, timestampMs: number): Buffer {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body as string, 'utf8');
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestampMs}.`, 'utf8')
    .update(bodyBuf)
    .digest();
}

/**
 * Compute the timestamp-bound signature: HMAC-SHA256 over
 * `"<timestampMs>." + rawBody`. Returns the value for X-Webhook-Signature-V2.
 */
export function signTimestampedWebhookBody(
  body: Buffer | string,
  secret: string,
  timestampMs: number,
): string {
  return `sha256=${timestampedHmac(body, secret, timestampMs).toString('hex')}`;
}

/**
 * All signature headers for an outbound delivery. Every sender should use this
 * so the timestamp, v2 signature and legacy signature always agree.
 */
export function buildWebhookSignatureHeaders(
  body: Buffer | string,
  secret: string,
  timestampMs: number = Date.now(),
): Record<string, string> {
  return {
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestampMs),
    [WEBHOOK_SIGNATURE_V2_HEADER]: signTimestampedWebhookBody(body, secret, timestampMs),
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(body, secret),
  };
}

export interface TimestampedVerifyOptions {
  /** Allowed clock skew in ms (default TIMESTAMP_TOLERANCE_MS). */
  toleranceMs?: number;
  /** Current time in ms (injectable for tests). */
  now?: number;
}

/**
 * Verify a timestamp-bound (v2) webhook signature.
 *
 * Rejects when the timestamp is missing, malformed or outside the replay
 * window, when the signature is missing/malformed or does not match
 * `HMAC(secret, "<timestamp>." + rawBody)` (compared with timingSafeEqual),
 * or when the same timestamp+signature was already accepted.
 */
export function verifyTimestampedWebhookSignature(
  rawBody: Buffer | string,
  secret: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  options: TimestampedVerifyOptions = {},
): VerifyResult | VerifyFailure {
  const toleranceMs = options.toleranceMs ?? TIMESTAMP_TOLERANCE_MS;
  const now = options.now ?? Date.now();

  if (!timestampHeader) {
    return { ok: false, reason: `Missing ${WEBHOOK_TIMESTAMP_HEADER} header` };
  }
  if (!TIMESTAMP_RE.test(timestampHeader)) {
    return { ok: false, reason: `${WEBHOOK_TIMESTAMP_HEADER} must be unix epoch milliseconds` };
  }
  const timestampMs = Number(timestampHeader);
  const skew = Math.abs(now - timestampMs);
  if (skew > toleranceMs) {
    return {
      ok: false,
      reason: `Request timestamp is outside the ${toleranceMs}ms tolerance window (skew: ${skew}ms)`,
    };
  }

  if (!signatureHeader) {
    return { ok: false, reason: `Missing ${WEBHOOK_SIGNATURE_V2_HEADER} header` };
  }
  const hexMatch = signatureHeader.trim().match(SIGNATURE_RE);
  if (!hexMatch) {
    return {
      ok: false,
      reason: `Malformed ${WEBHOOK_SIGNATURE_V2_HEADER} header (expected sha256=<hex64>)`,
    };
  }
  const receivedHex = hexMatch[1].toLowerCase();

  const expected = timestampedHmac(rawBody, secret, timestampMs);
  const received = Buffer.from(receivedHex, 'hex');
  // Both buffers are always 32 bytes, so timingSafeEqual cannot throw.
  if (!crypto.timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'Signature mismatch' };
  }

  // Replay check only after the signature is proven, so forged requests
  // cannot fill the cache.
  const nonce = `v2:${timestampMs}:${receivedHex}`;
  if (isReplay(nonce)) {
    return { ok: false, reason: 'Replayed request (nonce already seen)' };
  }
  // Keep the nonce for at least the whole window (both directions of skew).
  recordNonce(nonce, Math.max(REPLAY_CACHE_TTL_MS, toleranceMs * 2 + 10_000));

  return { ok: true, signatureHex: receivedHex };
}
