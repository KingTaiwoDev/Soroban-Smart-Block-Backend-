# Search and realtime cursor integration guide

This guide covers the two different continuation mechanisms exposed by the
API. They are deliberately not interchangeable.

## Search: use offset pagination

Use `GET /api/v1/search?q=<query>&type=<type>&limit=<n>&offset=<n>` for the
unified full-text index. `type` is one of `all`, `contract`, `event`, or
`transaction`; `limit` is 1–100 and `offset` is zero or greater. Supplying a
`type` selects the unified index. Omitting it retains the legacy
contract-source search and its `function:`, `event:`, and related facets.

Search is offset based, not stream-cursor based. Preserve the original query,
type, and highlight choice while increasing `offset` by the number of results
already consumed. Treat results as a current index view: indexing and ledger
progress can change later pages between requests.

```bash
curl -G "$BASE_URL/api/v1/search" \
  --data-urlencode 'q=transfer' \
  --data-urlencode 'type=event' \
  --data-urlencode 'limit=20' \
  --data-urlencode 'offset=0'
```

Invalid queries (including fewer than two characters, an unsupported type, or
an out-of-range limit) return HTTP 400. Retry transient 5xx responses with
backoff; do not turn an invalid query into repeated retries.

## Realtime: resume SSE with the message id

Use server-sent events for new indexed ledgers or a single contract's decoded
events:

- `GET /api/v1/realtime/ledgers`
- `GET /api/v1/realtime/contracts/:address/events?types=transfer,mint`

Each event has an SSE `id` and a JSON body containing the same monotonically
increasing `id`. Save the last successfully processed id durably. On a
reconnect, send it in the `Last-Event-ID` header (preferred) or as
`lastEventId`:

```bash
curl -N "$BASE_URL/api/v1/realtime/ledgers?lastEventId=481"
```

The server replays buffered messages whose id is greater than the supplied
id, then follows live messages. A replay id is an **in-process, bounded
availability cursor**, not a durable ledger checkpoint: the default replay
buffer is 5,000 messages, it is configured with `REALTIME_REPLAY_BUFFER_SIZE`,
and it is cleared by a process restart. Consumers must therefore deduplicate
by the domain key (`ledger.sequence` for ledgers and `pagingToken` for contract
events) and recover a gap with the REST events/transactions APIs.

The server advertises a three-second SSE retry interval and emits heartbeat
comments every 15 seconds. Back off further after network failures. A client
may open at most `REALTIME_MAX_SSE_PER_CLIENT` streams per source IP (default
five); excess streams receive HTTP 429. Contract streams reject malformed
contract IDs and more than 20 event types with HTTP 400.

## Network and rollout considerations

SSE ids are local to one backend process and one deployment. Never resume a
Mainnet stream using an id saved from Testnet, another region, or a prior
deployment. For a zero-loss consumer, combine the stream with periodic REST
reconciliation from your durable ledger or paging-token checkpoint.

Before relying on a new event type in production, validate its payload on the
target network: fixtures and Testnet can differ from Mainnet contract traffic.
