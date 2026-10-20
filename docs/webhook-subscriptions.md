# Webhook subscriptions

Self-service management of on-chain contract-event deliveries. All endpoints
require an API key (`X-Api-Key`) and are scoped to the key that owns the
subscription.

Base path: `/webhooks`

## Endpoints

| Method | Path                       | Purpose                                                     |
| ------ | -------------------------- | ----------------------------------------------------------- |
| POST   | `/webhooks`                | Create a subscription (returns the signing secret **once**) |
| GET    | `/webhooks`                | List subscriptions (secrets omitted)                        |
| PATCH  | `/webhooks/:id`            | Update URL, filters, or active state                        |
| DELETE | `/webhooks/:id`            | Delete a subscription                                       |
| POST   | `/webhooks/:id/verify`     | Challenge/response URL verification                         |
| POST   | `/webhooks/:id/ping`       | Send a synthetic test event                                 |
| GET    | `/webhooks/:id/preview`    | Preview the exact body + signing headers                    |
| GET    | `/webhooks/:id/deliveries` | Recent delivery attempts (last 50)                          |
| GET    | `/webhooks/sdk`            | Integration guide + verification snippets                   |
| POST   | `/webhooks/:id/replay`     | Request event replay from a ledger checkpoint               |
| GET    | `/webhooks/:id/replay`     | List replay jobs for a subscription                         |
| GET    | `/webhooks/:id/replay/:jobId` | Get progress and status of a replay job                  |
| POST   | `/webhooks/:id/replay/:jobId/resume` | Resume an interrupted replay job                  |
| POST   | `/webhooks/:id/replay/:jobId/cancel` | Cancel an in-flight replay job                     |

### Create

```bash
curl -X POST https://api.example.com/webhooks \
  -H "X-Api-Key: $SOROBAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/hook","eventType":"transfer"}'
```

The response includes `secret`. It is shown **only once** — store it in your
secret manager. If omitted, the server generates a 256-bit secret.

New subscriptions start `verified: false`.

Batch subscription example (requires the `webhookBatchDelivery` flag to be
enabled by an administrator):

```bash
curl -X POST https://api.example.com/webhooks \
  -H "X-Api-Key: $SOROBAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/hook","eventType":"transfer","deliveryStrategy":"batch","batchSize":50,"batchWindowMs":50}'
```

Subscriptions default to `deliveryStrategy: "immediate"`, preserving the
single-event payload. To opt into aggregation, set `deliveryStrategy` to
`"batch"` and optionally set `batchSize` (2-500, default 100) and
`batchWindowMs` (0-60,000, default 50). Batch mode is available only while the
`webhookBatchDelivery` feature flag is enabled and its migration is present.
If the flag is switched off, new events fall back to immediate delivery unless
they must queue behind an already-admitted batch for the same contract; queued
batches continue draining. A batch subscription cannot be switched to
immediate mode or changing its destination until pending batches have drained
(409 `BATCH_QUEUE_NOT_DRAINED`). Switching from immediate to batch is also
rejected with 409 while immediate deliveries are outstanding.

### Update

```bash
curl -X PATCH https://api.example.com/webhooks/$SUB_ID \
  -H "X-Api-Key: $SOROBAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"eventType":"mint","active":true}'
```

`url`, `contractAddress`, `eventType`, and `topicSymbol` may be updated; pass
`null` to clear a filter. `deliveryStrategy`, `batchSize`, and `batchWindowMs`
may also be updated within the bounds above. Changing the `url` resets
verification — run the handshake again. Deactivating (`active: false`)
immediately cancels pending deliveries and queued events.

## Verification handshake (challenge/response)

Prove you own the destination URL before relying on deliveries:

1. `POST /webhooks/:id/verify`.
2. The server sends a signed request to your URL:

   ```json
   {
     "type": "webhook.verification",
     "subscriptionId": "019...",
     "challenge": "<random hex>",
     "timestamp": "2026-09-24T00:00:00.000Z"
   }
   ```

   It carries the same `X-Webhook-Timestamp`, `X-Webhook-Signature-V2` and
   `X-Webhook-Signature` headers as a normal delivery.

3. Respond with HTTP 2xx and echo the challenge back:

   ```json
   { "challenge": "<the value you received>" }
   ```

   A plain-text response equal to the challenge is also accepted. Challenges
   expire after 15 minutes.

4. On success the subscription is marked `verified` and `GET /webhooks` reports
   `verified: true` / `verifiedAt`.

Only the SHA-256 digest of the in-flight challenge is stored server-side, so a
database leak cannot be used to forge a response. Comparison is constant-time.

## Test send (ping)

```bash
curl -X POST https://api.example.com/webhooks/$SUB_ID/ping \
  -H "X-Api-Key: $SOROBAN_API_KEY"
```

Sends one signed synthetic event and records it as a delivery. **No retry is
scheduled** — a ping is a one-shot connectivity/signature test. The response
reports `success`, `httpStatus`, `durationMs`, and `deliveryId`. Requests to
SSRF-blocked URLs return `400`.

## Payload preview

```bash
curl https://api.example.com/webhooks/$SUB_ID/preview \
  -H "X-Api-Key: $SOROBAN_API_KEY"
```

Returns the sample `event`, the exact `rawBody`, and the `X-Webhook-Timestamp`,
`X-Webhook-Signature-V2` and `X-Webhook-Signature` headers — with real
signatures over the sample body — so you can unit-test your receiver before
receiving live traffic.

## Delivery envelope

```json
{
  "event": {
    "id": "string",
    "contractAddress": "string",
    "eventType": "string",
    "topicSymbol": "string | null",
    "decoded": {},
    "ledgerSequence": 0,
    "ledgerCloseTime": "ISO-8601 string",
    "transactionHash": "string"
  },
  "attempt": 1
}
```

Headers:

- `X-Webhook-Timestamp: <unix epoch ms>`
- `X-Webhook-Signature-V2: sha256=<hex HMAC-SHA256 of "<timestamp>." + raw body>`
- `X-Webhook-Signature: sha256=<hex HMAC-SHA256 of the raw body>` (deprecated,
  see [Compatibility](#compatibility-legacy-x-webhook-signature))

Batch deliveries use this envelope instead:

```json
{
  "batchId": "stable-for-this-batch",
  "idempotencyKey": "sha256-hex",
  "events": [{ "id": "string", "ledgerSequence": 0 }],
  "attempt": 1
}
```

The signatures cover the complete raw JSON body. The request also includes
`Idempotency-Key` with the same value as `idempotencyKey`. Event membership and
the key are stable across retries; `attempt` increases. Consumers should
deduplicate by `idempotencyKey`. Events are ordered per contract by ledger
sequence, transaction hash, then event ID. Batch bodies are limited to 1 MB;
the batch size is capped at 500 events. A single event too large for the body
limit is recorded with `PAYLOAD_TOO_LARGE` and is not retried.

`GET /webhooks/:id/deliveries` includes `idempotencyKey` and `errorCode`, but
does not return persisted batch payload snapshots. Error codes are
`SSRF_BLOCKED`, `HTTP_NON_2XX`, `NETWORK_ERROR`, and `PAYLOAD_TOO_LARGE`.

## Replay retention

Batch event snapshots and delivery metadata are retained for at least 90 days.
This implementation does not yet provide an arbitrary-checkpoint replay API;
retention is not equivalent to checkpoint replayability.

## Verifying signatures

Each delivery is signed over the timestamp **and** the body, so a captured
request cannot be replayed with a new `X-Webhook-Timestamp`:

```
signed_payload = X-Webhook-Timestamp + "." + raw_request_body_bytes
X-Webhook-Signature-V2 = "sha256=" + hex(HMAC-SHA256(signing_secret, signed_payload))
```

Receivers should:

1. Reject requests that are missing `X-Webhook-Timestamp` or
   `X-Webhook-Signature-V2`.
2. Reject timestamps more than the tolerance window (default 5 minutes,
   `WEBHOOK_TIMESTAMP_TOLERANCE_MS`) away from their own clock.
3. Recompute the HMAC over the **raw** body bytes (before JSON parsing) and
   compare it in constant time (`crypto.timingSafeEqual` / `hmac.compare_digest`).
4. Remember accepted `(timestamp, signature)` pairs for the window and reject
   repeats. Retries are signed with a fresh timestamp, so they are not
   repeats.

TypeScript:

```ts
import crypto from 'crypto';

export function verifyWebhook(
  rawBody: Buffer,
  secret: string,
  signature: string, // X-Webhook-Signature-V2
  timestamp: string, // X-Webhook-Timestamp
  toleranceMs = 5 * 60 * 1000,
) {
  const ts = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() - ts) > toleranceMs) {
    throw new Error('Timestamp outside tolerance window');
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid signature');
  }
}
```

Inside this codebase, `verifyTimestampedWebhookSignature` in
`src/webhooks/webhookVerify.ts` implements all four steps.

### Compatibility: legacy `X-Webhook-Signature`

`X-Webhook-Signature` (HMAC of the body only) is still sent on every delivery,
verification handshake, ping and preview, so existing receivers keep working
unchanged. The timestamp is not part of that signature, so it does not stop
replays: anyone who captured a delivery can resend it with a new
`X-Webhook-Timestamp`. Migrate receivers to `X-Webhook-Signature-V2`. The legacy
header will be removed in a future release, with notice in the changelog.
Signing secrets are unchanged, so migrating needs no secret rotation. The same
headers and rules apply on testnet, mainnet and devnet.

Python and Go snippets, plus the full envelope reference, are served live from
`GET /webhooks/sdk` so they stay in sync with the retry policy and tolerance
window configured on the server.

## Retries

Immediate failed deliveries are retried with exponential backoff and stop after
five attempts. Batch deliveries retry network and non-2xx failures indefinitely
with capped exponential backoff so destination outages do not discard queued
events. Retries stop for inactive subscriptions and for URLs blocked by the
SSRF guard; those terminal outcomes are visible in delivery history. Inspect
results via `GET /webhooks/:id/deliveries`.

## Replay from checkpoint

Recover missed events starting from a validated ledger sequence:

```bash
curl -X POST https://api.example.com/webhooks/$SUB_ID/replay \
  -H "X-Api-Key: $SOROBAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fromLedger":10500,"toLedger":11000,"idempotencyKey":"replay-recovery-1"}'
```

- **Validation:** `fromLedger` must be >= 1, `toLedger >= fromLedger`, and the range cannot exceed 10,000 ledgers.
- **Idempotency:** Supplying an `idempotencyKey` prevents duplicate replay jobs.
- **Progress Tracking:** Check status and events replayed via `GET /webhooks/:id/replay/:jobId`.
- **Interruption & Resumption:** If interrupted, resume from the last processed checkpoint via `POST /webhooks/:id/replay/:jobId/resume`.
- **Replay Markers:** Replayed payloads carry `replayed: true` and headers `X-Webhook-Replay: true` and `X-Webhook-Replay-Job-Id`. Signatures are computed over the exact replayed body.
