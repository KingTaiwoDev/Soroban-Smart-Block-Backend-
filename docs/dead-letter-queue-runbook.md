# Indexer dead-letter queue runbook

The Prometheus rules alert on items that have remained in the DLQ for one hour
or one day, and on sustained growth (more than 25 newly dead-lettered items per
15-minute window for 10 minutes). Metrics are labeled by `network`, so triage
the indicated network profile only.

## Triage

1. Check `indexer_error_dlq_oldest_age_seconds{network="<network>"}`,
   `indexer_error_queue_depth{queue="dead"}`, and the per-network rate of
   `indexer_error_dlq_total` split by `reason`.
2. Authenticate to the matching network's admin API and inspect
   `GET /api/v1/admin/dead-letter`. Do not reprocess or purge items until their
   network, ledger, error, and payload are confirmed.
3. Group failures by reason. For `network` or timeout failures, check the
   matching network's RPC/Horizon health and credentials. For poison or
   retry-exhausted failures, inspect the decoder error and raw XDR before
   deploying a parser fix.
4. Resolve the cause, verify the corresponding network's indexer is healthy,
   then reprocess selected items using the audited operator command. It requires
   an item id, a named operator, and an incident/change reason; each successful
   replay is committed with its audit record atomically:

   ```sh
   STELLAR_NETWORK=testnet npm run admin:dead-letter-replay -- \
     --id <dead-letter-id> --actor <operator-id> --reason <incident-or-change-id>
   ```

   Add `--dry-run` to validate the invocation without changing the queue.
   The command intentionally accepts one item at a time so a bulk replay cannot
   bypass review. Purge only items confirmed to be permanently irrelevant.
5. Confirm the network's queue depth falls, oldest-item age resets, and the
   growth alert clears. Check the other network profiles separately; their DLQs
   and databases must remain isolated.

The oldest-item gauge is refreshed during error-queue metric updates and
backpressure reads. A database query failure is surfaced to the caller rather
than being reported as an empty queue.
