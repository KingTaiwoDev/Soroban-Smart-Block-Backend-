# Reliability Game Day: Database and RPC Failover

This document describes the operational procedure, failure scenarios, and validation criteria for executing a Reliability Game Day on the Soroban Smart Block Explorer backend.

The game day exercises automated failover mechanisms across two critical dependencies:

1. **Database Read/Write Separation**: Transparent routing from read replicas to the primary database when replication lag exceeds the safety threshold or when a replica fails.
2. **Stellar RPC Resiliency**: Automatic failover across configured RPC endpoints (`<NETWORK>_RPC_FALLBACK_URLS`) on transient outages, HTTP 429 rate limits, and server errors, maintaining sticky healthy endpoint selection.

---

## 1. Objectives and Service Level Targets

| Metric                             |       Target | Measurement                                                                   |
| ---------------------------------- | -----------: | ----------------------------------------------------------------------------- |
| **Recovery Time Objective (RTO)**  | ≤ 60 minutes | Interval from declaring simulated failure to normal service operation         |
| **Recovery Point Objective (RPO)** | ≤ 15 minutes | Maximum data gap between restored/failover state and pre-incident state       |
| **Replica Lag Failover Threshold** |  > 5 ledgers | `measureReplicaLag()` triggers automatic read redirection to primary client   |
| **RPC Degradation Threshold**      | > 10% errors | Alerts `StellarRpcEndpointFailover` and `StellarRpcSustainedDegradation` fire |

---

## 2. Pre-Game Day Safety Controls

1. **Isolation**: Never execute destructive drills on a production database or live production traffic. Game days must be conducted on an isolated staging or sandbox environment.
2. **Credential Protection**: Database passwords and RPC tokens must be supplied via environment variables (`TESTNET_DATABASE_URL`, `TESTNET_RPC_URL`). Never pass secrets as command-line arguments or log them in plain text.
3. **Rollback Plan**: Ensure primary database backups and PITR are healthy before initiating faults.
4. **Baseline Metrics**: Confirm Prometheus is scraping `/metrics` and that `/readyz` and `/healthz` report healthy status before injecting failures.

---

## 3. Failure Scenarios and Runbook

### Scenario A: Database Read Replica Degradation & Outage

1. **Fault Injection**:
   - Inject synthetic replication lag (> 5 ledgers) or terminate the PostgreSQL read-replica container.
2. **System Response**:
   - `measureReplicaLag()` detects lag exceeding `LAG_THRESHOLD_LEDGERS` (5 ledgers) or encounters connection refusal.
   - `getReadClient()` automatically falls back to returning the primary write client.
   - Read requests continue serving valid responses without throwing 500 errors.
   - The metric `replicaLagCheckErrors` increments if connection errors occurred during lag measurement.
3. **Recovery Verification**:
   - Restore replication sync on the replica container.
   - Within the lag cache TTL (5 seconds), verify `measureReplicaLag()` drops back to $\le 5$ ledgers and read traffic resumes routing to the replica.

### Scenario B: Primary Stellar RPC Outage & Sticky Failover

1. **Fault Injection**:
   - Simulate a network disruption, HTTP 503 Service Unavailable, or HTTP 429 Rate Limit on the primary RPC endpoint.
2. **System Response**:
   - RPC request to the primary endpoint fails.
   - The client advances to the first fallback URL configured in `<NETWORK>_RPC_FALLBACK_URLS`.
   - Once the fallback endpoint succeeds, it becomes the **active** endpoint for subsequent requests (sticky selection).
   - Prometheus metric `rpc_endpoint_failovers_total{network,from_endpoint,to_endpoint}` increments.
   - Metric `rpc_endpoint_active{network,endpoint}` reflects the new active endpoint.
3. **Negative/Failure Case — Non-Rotation on Client 4xx**:
   - Client sends an invalid XDR or bad parameter resulting in HTTP 400 Bad Request.
   - The system must reject the request **without** rotating the RPC endpoint.
4. **Negative/Failure Case — Endpoint Exhaustion**:
   - All configured RPC endpoints fail.
   - The system returns the original actionable error, preserves state integrity, and alerts `StellarRpcSustainedDegradation`.

---

## 4. Automated Game Day Execution

Run the automated game day drill using the repository drill script:

```bash
# Execute full drill across Database and RPC failover
bash scripts/reliability-game-day-drill.sh all

# Test database replica failover only
bash scripts/reliability-game-day-drill.sh database

# Test RPC failover only
bash scripts/reliability-game-day-drill.sh rpc
```

To test failure handling and abort behavior:

```bash
# Verify fail-closed behavior on simulated fatal DB failure
SIMULATE_FAILURE=db_fail bash scripts/reliability-game-day-drill.sh database

# Verify fail-closed behavior on all-RPC-endpoints down
SIMULATE_FAILURE=rpc_exhausted bash scripts/reliability-game-day-drill.sh rpc
```

---

## 5. Network-Specific Implications

- **Devnet**: Accepts plain HTTP endpoints (`http://`) and local Docker services. Devnet ledger production may pause during drills.
- **Testnet**: Standard environment for running regular quarterly game day exercises. Uses SDF Testnet infrastructure and public fallbacks.
- **Mainnet**:
  - Live mainnet execution is forbidden without explicit authorization (`ALLOW_MAINNET_DRILL=true`).
  - Fallback URLs must strictly use HTTPS (`https://`) with provider diversity (avoiding shared upstream infrastructure).

---

## 6. Post-Game Day Reporting and Remediation

After each game day:

1. Record timestamp, simulated incident time, and recovery time.
2. Confirm RTO was achieved ($\le 60\text{ minutes}$) and RPO was maintained ($\le 15\text{ minutes}$).
3. Audit application and Prometheus logs to verify no credentials or connection secrets were emitted.
4. Verify all alerts cleared once services returned to normal.
