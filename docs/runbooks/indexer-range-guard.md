# Indexer ledger-range guard

Before a catch-up cursor advances, the indexer treats the processed ledger
range as incomplete when one or more ledger rows are absent. Missing ranges are
kept separate from the forward cursor: repair replays only those ranges and
never rewinds already completed work. Upserts make such replays idempotent.

Catch-up is bounded by `INDEXER_CATCHUP_MAX_LEDGERS` (default 1000) and
`INDEXER_CATCHUP_MAX_MS` (default 30000). A run that reaches either boundary
commits only completed work; the next polling cycle resumes from that cursor.

Repeated database writes at or above `INDEXER_DB_WRITE_LATENCY_MS` (default
500ms) trigger a bounded delay after `INDEXER_DB_SLOW_WRITE_SAMPLES` samples
(default 3). Tune `INDEXER_BACKPRESSURE_DELAY_MS` (default 250ms) per network.
Do not share a budget or latency threshold between mainnet and testnet workers.

During an incident, pause the affected network worker, inspect unresolved
`LedgerGap` rows, run the existing repair tool for the exact range, and resume.
Never move the cursor manually past a missing range; that converts a repairable
gap into silent data loss.
