# Webhook Batch Delivery Design

## Status

Implementation status: partial. The opt-in API, database outbox, per-entity
batching, retries, feature gate, metrics, alert rules, and dashboard artifact
are implemented. Load/chaos/property evidence, deployment provisioning, and
arbitrary-checkpoint replay remain open; this is not a claim that RT10 is done.

## Current Delivery Path

`src/indexer/indexer.ts` persists decoded events, publishes them to the feed,
and awaits webhook dispatch. Immediate subscriptions retain the current
single-event payload; batch subscriptions write immutable event snapshots to
`_webhook_outbox_events`. A 25 ms worker groups ready snapshots into leased
`WebhookDelivery` records, and the existing retry worker retries the persisted
payload and idempotency key. A database lease recovers claimed work after a
process restart.

## Proposed Contract

- Existing subscriptions keep the current single-event envelope by default.
- Batching is opt-in per subscription and remains default-off behind the
  `webhookBatchDelivery` feature flag.
- A batch request contains a bounded, non-empty `events` array, a stable
  `batchId`, a stable `idempotencyKey`, and the retry `attempt`. Event entries
  use the current event shape without transformation.
- Events within a batch are ordered by ledger sequence, transaction hash, then
  event ID. The receiver deduplicates by `idempotencyKey`; delivery is
  at-least-once, not exactly-once, because the sender cannot know whether a
  receiver committed a request when the connection fails.
- Batch size (2-500), serialized body size (1 MB), interval (0-60 seconds),
  queue depth (50,000 events per subscription), and outbound concurrency are
  bounded. The worker reduces a batch to fit the body cap; a single event
  exceeding that limit is recorded as a terminal, classified failure.
- The batch interval is a maximum collection delay, not a latency promise.
  Configurations allowing windows above the delivery SLO cannot claim that SLO
  for low-volume subscriptions.

## Persistence And Recovery

Use a database-backed outbox rather than memory buffering. The outbox must
record immutable event payload snapshots, subscription ID, ordered membership,
stable batch/idempotency keys, status, attempt, next retry time, and a leased
worker claim. A unique constraint on subscription plus source event prevents
duplicate enqueue on indexer replay. A batch's membership and idempotency key
must not change across retries.

The producer writes the event and outbox membership transactionally. Workers
claim due work atomically, group only compatible subscription/window items,
and release or advance leases on every failure path. A crash after receiver
acceptance but before local acknowledgement may cause redelivery; the stable
idempotency key makes that case detectable by receivers. Ordering is enforced
per entity key across batches, not merely within a single HTTP body.

Replay for 90 days requires retaining the payload snapshot and checkpoint
metadata for at least 90 days independently of event-table pruning. Existing
delivery response retention is not sufficient evidence of event replayability.

## Alternatives Considered

- **In-memory interval buffers:** rejected because they lose events on process
  restart and cannot be safely shared across replicas.
- **One delivery row containing a mutable JSON array:** rejected because
  concurrent producers can overwrite membership, and a retry cannot identify
  the exact request previously attempted.
- **Exactly-once HTTP delivery:** rejected as an unprovable guarantee across a
  network boundary without receiver participation. Stable idempotency keys and
  at-least-once retry are the supported contract.
- **WebSocket connection batching:** out of scope for webhook POST callbacks.
  The 100,000-concurrent-connection requirement applies to a persistent
  connection service and needs a separate target, capacity model, and load
  environment; it cannot be inferred from webhook request throughput.

## Operational Gates

Before enabling batch mode for production tenants, deploy the migration, enable
the default-off flag, configure Prometheus scraping for `/metrics`, load the
Grafana dashboard, and load `prometheus/alerts.yml`. The OTLP exporter is
already present in the lockfile through the pinned OpenTelemetry SDK; it is
used for metrics without adding a package. The dependency rationale is to
reuse the project's existing OTLP collector endpoint and SDK versions instead
of introducing a second telemetry stack. This rationale still requires PR
review approval under the repository's dependency policy.

The committed SLO targets are 99.9% successful batch delivery attempts over
30 days (0.1% error budget) and p99 event-to-client latency below 100 ms. These
are targets, not measured results. Dashboard JSON and alert rules are committed
but are not auto-provisioned by the current Docker Compose configuration.

Still required: unit and database integration tests for idempotent enqueue,
ordering, lease expiry, retry grouping, and cancellation; fault tests for
crashes before send, after remote acceptance, and during acknowledgement;
property tests over interleaved entity keys; bounded-memory slow-consumer
tests; and CI enforcement of those checks. Sustained 10x-peak testing needs a
documented peak baseline and a 30-minute load runner. The current repository
does not establish that baseline or provide a 100,000-connection runner.
Webhook POST callbacks do not hold 100,000 persistent connections, so that
criterion needs an explicit scope decision before it can be meaningfully
validated. An arbitrary-checkpoint replay API is implemented via `POST /webhooks/:id/replay`:
subscription owners can request controlled, idempotent, and resumable event replay starting
from a validated ledger checkpoint, subject to range limits (up to 10,000 ledgers) and
signature verification.

## Compatibility And Rollback

The first production rollout must leave existing subscriptions on immediate
single-event delivery. Batch mode is enabled only for explicitly configured
subscriptions while the feature flag is on. Rollback disables new batch
admission, drains or retries already persisted batches using their original
membership and key, and preserves the existing single-event retry path. No
database budget, coverage threshold, test exclusion, or lint/typecheck budget
may be relaxed to ship this work.