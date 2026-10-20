/**
 * Timestamp-bound webhook signatures and replay-window checks (#1239).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildWebhookSignatureHeaders,
  signTimestampedWebhookBody,
  signWebhookBody,
  TIMESTAMP_TOLERANCE_MS,
  verifyTimestampedWebhookSignature,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_V2_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../src/webhooks/webhookVerify';

const SECRET = 'whsec_test_secret';
const NOW = 1_760_000_000_000;

let seq = 0;
/** Unique body per test — accepted nonces are cached module-wide. */
function body(): string {
  return JSON.stringify({ event: { id: `evt-${++seq}`, type: 'transfer' }, attempt: 1 });
}

function sign(raw: string, ts = NOW) {
  const headers = buildWebhookSignatureHeaders(raw, SECRET, ts);
  return {
    signature: headers[WEBHOOK_SIGNATURE_V2_HEADER],
    timestamp: headers[WEBHOOK_TIMESTAMP_HEADER],
    legacy: headers[WEBHOOK_SIGNATURE_HEADER],
  };
}

const verify = (raw: string | Buffer, signature?: string, timestamp?: string, now = NOW) =>
  verifyTimestampedWebhookSignature(raw, SECRET, signature, timestamp, { now });

describe('buildWebhookSignatureHeaders', () => {
  it('signs "<timestamp>.<body>" with HMAC-SHA256 for the v2 header', () => {
    const raw = body();
    const { signature, timestamp } = sign(raw);
    const expected = crypto.createHmac('sha256', SECRET).update(`${NOW}.${raw}`).digest('hex');

    expect(timestamp).toBe(String(NOW));
    expect(signature).toBe(`sha256=${expected}`);
    expect(signTimestampedWebhookBody(raw, SECRET, NOW)).toBe(signature);
  });

  it('keeps the legacy body-only header unchanged for existing consumers', () => {
    const raw = body();
    const { legacy } = sign(raw);
    const expected = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

    expect(legacy).toBe(`sha256=${expected}`);
    expect(legacy).toBe(signWebhookBody(raw, SECRET));
    // Legacy receivers still verify successfully.
    expect(verifyWebhookSignature(raw, SECRET, legacy).ok).toBe(true);
  });

  it('defaults the timestamp to the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 42);
    try {
      const headers = buildWebhookSignatureHeaders(body(), SECRET);
      expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toBe(String(NOW + 42));
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds the signature to the timestamp', () => {
    const raw = body();
    expect(sign(raw, NOW).signature).not.toBe(sign(raw, NOW + 1).signature);
  });
});

describe('verifyTimestampedWebhookSignature', () => {
  it('accepts a fresh, correctly signed request', () => {
    const raw = body();
    const { signature, timestamp } = sign(raw);
    expect(verify(raw, signature, timestamp)).toMatchObject({ ok: true });
  });

  it('accepts Buffer bodies and bare-hex / upper-case signatures', () => {
    const raw = body();
    const { signature, timestamp } = sign(raw);
    const bare = signature.replace('sha256=', '').toUpperCase();
    expect(verify(Buffer.from(raw), bare, timestamp).ok).toBe(true);
  });

  it('accepts timestamps at the edge of the tolerance window in both directions', () => {
    const past = body();
    const pastTs = NOW - TIMESTAMP_TOLERANCE_MS;
    const p = sign(past, pastTs);
    expect(verify(past, p.signature, p.timestamp).ok).toBe(true);

    const future = body();
    const futureTs = NOW + TIMESTAMP_TOLERANCE_MS;
    const f = sign(future, futureTs);
    expect(verify(future, f.signature, f.timestamp).ok).toBe(true);
  });

  it('rejects a replay of an accepted request inside the window', () => {
    const raw = body();
    const { signature, timestamp } = sign(raw);
    expect(verify(raw, signature, timestamp).ok).toBe(true);

    const replay = verify(raw, signature, timestamp, NOW + 1000);
    expect(replay).toEqual({ ok: false, reason: 'Replayed request (nonce already seen)' });
  });

  it('rejects stale and future-dated timestamps outside the window', () => {
    const stale = body();
    const s = sign(stale, NOW - TIMESTAMP_TOLERANCE_MS - 1);
    expect(verify(stale, s.signature, s.timestamp)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('tolerance window'),
    });

    const future = body();
    const f = sign(future, NOW + TIMESTAMP_TOLERANCE_MS + 1);
    expect(verify(future, f.signature, f.timestamp).ok).toBe(false);
  });

  it('rejects a captured request re-sent with a fresh timestamp header', () => {
    const raw = body();
    const captured = sign(raw, NOW - TIMESTAMP_TOLERANCE_MS - 60_000);
    // Attacker swaps in a current timestamp but cannot re-sign.
    const result = verify(raw, captured.signature, String(NOW));
    expect(result).toEqual({ ok: false, reason: 'Signature mismatch' });
  });

  it('rejects the legacy body-only signature in the v2 check', () => {
    const raw = body();
    const { legacy, timestamp } = sign(raw);
    expect(verify(raw, legacy, timestamp)).toEqual({ ok: false, reason: 'Signature mismatch' });
  });

  it('rejects a tampered body', () => {
    const raw = body();
    const { signature, timestamp } = sign(raw);
    expect(verify(`${raw} `, signature, timestamp).ok).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const raw = body();
    const forged = signTimestampedWebhookBody(raw, 'wrong-secret', NOW);
    expect(verify(raw, forged, String(NOW))).toEqual({ ok: false, reason: 'Signature mismatch' });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-numeric', 'abc'],
    ['decimal', `${NOW}.5`],
    ['negative', `-${NOW}`],
    ['ISO date', new Date(NOW).toISOString()],
    ['exponent notation', '1.76e12'],
  ])('rejects a %s timestamp', (_label, timestamp) => {
    const raw = body();
    const { signature } = sign(raw);
    const result = verify(raw, signature, timestamp);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/X-Webhook-Timestamp/);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong algorithm prefix', `sha1=${'a'.repeat(64)}`],
    ['too short', `sha256=${'a'.repeat(63)}`],
    ['non-hex', `sha256=${'z'.repeat(64)}`],
  ])('rejects a %s signature without throwing', (_label, signature) => {
    const raw = body();
    const result = verify(raw, signature, String(NOW));
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/X-Webhook-Signature-V2/);
  });

  it('does not let forged requests poison the replay cache', () => {
    const raw = body();
    const { signature, timestamp } = sign(raw);
    const forged = signTimestampedWebhookBody(raw, 'wrong-secret', NOW);
    expect(verify(raw, forged, timestamp).ok).toBe(false);
    // The genuine request is still accepted afterwards.
    expect(verify(raw, signature, timestamp).ok).toBe(true);
  });

  it('compares signatures with crypto.timingSafeEqual', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    try {
      const raw = body();
      const { signature, timestamp } = sign(raw);
      verify(raw, signature, timestamp);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('honours a custom tolerance window', () => {
    const raw = body();
    const { signature, timestamp } = sign(raw, NOW - 2_000);
    const result = verifyTimestampedWebhookSignature(raw, SECRET, signature, timestamp, {
      now: NOW,
      toleranceMs: 1_000,
    });
    expect(result.ok).toBe(false);
  });
});

describe('outbound senders use the shared signature headers', () => {
  it.each([
    'src/webhooks/dispatcher.ts',
    'src/api/webhooks.ts',
    'src/api/developer/webhooks.ts',
    'src/api/authWebhooks.ts',
  ])('%s signs via buildWebhookSignatureHeaders', (file) => {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    expect(source).toMatch(/buildWebhookSignatureHeaders\(/);
    // No hand-rolled, timestamp-less signature headers.
    expect(source).not.toMatch(/'X-Webhook-Signature':\s*(signWebhookBody|`sha256=)/);
  });
});
