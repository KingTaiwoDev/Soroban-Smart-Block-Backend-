# Maintainer Triage Guide: Reports, Incidents, and Data Disputes

## 1. Purpose and Scope

This document defines the standard operating procedures (SOP), classification taxonomy, response SLAs, and resolution lifecycles for maintainers of the Soroban Smart Block Explorer backend.

It governs three core operational domains:
1. **Community Reports & Security Vulnerability Disclosures**: Managing responsible disclosures, bug reports, and coordinated security releases.
2. **Production Incident Management**: Rapid response, mitigation, and postmortems for indexer stalls, RPC failovers, cache partitions, and database exhaustion.
3. **Contract Metadata & Data Disputes**: Resolving conflicting ABI submissions, malicious token spoofing, and metadata provenance challenges.

---

## 2. Severity Classification Matrix & SLAs

Every report, alert, or dispute must be evaluated using the triage engine (`src/services/triage-helper.ts`) according to impact, network, and blast radius:

| Severity | Target SLA | Page On-Call? | Escalation Role | Definition & Criteria | Examples |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **P0** | **≤ 15 mins** | **YES** (PagerDuty / OpsGenie) | Incident Commander & Tech Lead | Active exploit, Mainnet ledger data corruption, total API outage, or database write unavailability. | • Active exploit in contract execution simulator.<br>• Mainnet indexer dropping ledger transactions.<br>• PostgreSQL connection exhaustion taking down public API. |
| **P1** | **≤ 60 mins** | **YES** | Primary On-Call Engineer | Mainnet high-impact degradation, testnet total outage, enterprise rate-limit cross-replica cache sync failure, or high-severity security report. | • RPC provider failing on Mainnet triggering degraded failover.<br>• Redis pub/sub partition leading to persistent `ENTERPRISE_TIER_INVALIDATION_DEGRADED`.<br>• Testnet indexing halted for > 100 ledgers. |
| **P2** | **≤ 4 hours** | NO (Business Hours) | Maintainer Queue | Contested metadata/ABI disputes, single-contract indexing anomalies, or testnet partial performance degradation. | • Token creator disputing an unverified community ABI submission.<br>• Rate-limit edge case causing unexpected 429s for a single developer.<br>• Testnet archive search latency spike. |
| **P3** | **≤ 24 hours** | NO | Backlog Triage | Cosmetic issues, documentation discrepancies, Devnet hiccups, or low-priority feature enhancement requests. | • Typo in OpenAPI schema example.<br>• Devnet docker compose script port conflict.<br>• Non-blocking community feature suggestion. |

---

## 3. Standard Operating Procedures (SOPs)

### SOP 1: Security Disclosures and Community Reports

1. **Intake & Containment**:
   - Submissions received via security advisories (`security@soroban-explorer.org`) or GitHub Security Advisories.
   - Maintainer acknowledges receipt within the SLA (P0: 15m, P1: 60m).
   - Assess CVSS score and verify if the vulnerability is actively exploitable on Mainnet.
2. **Reproduction in Isolation**:
   - Recreate the scenario using Devnet or a local sandbox environment. **Never test active exploits against production endpoints.**
3. **Patching & Coordinated Disclosure**:
   - Develop fix in a private branch.
   - Run full regression suites (`npm run test:ci`).
   - Coordinate release window with the reporter under a standard 90-day embargo (or 7 days for critical zero-days).
4. **Deployment & Verification**:
   - Deploy first to staging/canary, verify telemetry metrics, and roll out to production.
   - Issue security advisory release notes with CVE reference if applicable.

---

### SOP 2: Production Incident Management

#### 2.1 Incident Response Workflow
```
[Anomaly Detected] ──► [Evaluate Severity: P0/P1] ──► [Declare Incident Channel]
                                                               │
                                                               ▼
[Postmortem & Actions] ◄── [Verify Recovery] ◄── [Apply Mitigation Runbook]
```

#### 2.2 Common Incident Runbooks

##### A. Indexer Stalled or Lagging Behind Tip
* **Symptoms**: Metric `indexer_ledger_lag_ledgers > 10` or `indexer_freshness_seconds > 60`.
* **Immediate Actions**:
  1. Inspect primary Stellar RPC status: `curl -s -X POST $STELLAR_RPC_URL -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'`.
  2. If primary RPC is unresponsive, force failover by checking secondary RPC endpoints.
  3. Verify database write throughput and locks: `SELECT pid, query, age(clock_timestamp(), query_start) FROM pg_stat_activity WHERE state != 'idle';`.
  4. If indexer process is stuck on memory exhaustion, restart indexer service under supervision (`systemctl restart soroban-indexer`).

##### B. Enterprise Tier Cross-Replica Sync Lag
* **Symptoms**: Log diagnostic `ENTERPRISE_TIER_INVALIDATION_DEGRADED` or propagation latency `> 500ms`.
* **Immediate Actions**:
  1. Check Redis pub/sub connectivity: `redis-cli ping` on channel `__enterprise_tier:invalidate`.
  2. If Redis is unreachable or partitioned, the system automatically falls back to 5-minute memory TTL.
  3. Verify whether API replicas have restored fallback polling. Reconnect or restart Redis sentinel.

##### C. Database Connection Exhaustion
* **Symptoms**: Error `FATAL: remaining connection slots are reserved for non-privileged connections`.
* **Immediate Actions**:
  1. Inspect PgBouncer pooler status: `SHOW POOLS; SHOW CLIENTS;`.
  2. Terminate idle or leaking backend connections:
     ```sql
     SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle in transaction' AND age(clock_timestamp(), query_start) > interval '2 minutes';
     ```
  3. Verify API replica pool sizing configuration (`max: 20` per replica).

---

### SOP 3: Contract Metadata & Data Dispute Resolution

Data disputes occur when multiple parties submit conflicting ABIs, contract names, or descriptions, or when a malicious actor attempts token/ticker spoofing.

#### 3.1 Dispute Lifecycle State Machine

The dispute workflow is enforced by `transitionDisputeStatus`:

```
               ┌─────────────┐
        ┌─────►│   opened    │◄─────────────┐
        │      └──────┬──────┘              │
        │             │                     │
        │      ┌──────▼──────┐              │ (Reopen on appeal)
        │      │ quarantined │              │
        │      └──────┬──────┘              │
        │             │                     │
        │      ┌──────▼──────┐              │
        │      │investigating│              │
        │      └──────┬──────┘              │
        │             │                     │
        │      ┌──────▼──────┐              │
        │      │ arbitration │              │
        │      └──────┬──────┘              │
        │             │                     │
        │      ┌──────▼──────┐       ┌──────┴──────┐
        └──────┤  resolved   │       │  dismissed  │
               └─────────────┘       └─────────────┘
```

#### 3.2 Dispute Stages and Maintainer Checklist

1. **Intake (`opened`)**:
   - Issue ticket opened with affected contract address, network, conflicting submissions, and claimant identity.
2. **Quarantine (`quarantined`)**:
   - If spoofing or malicious metadata is suspected on Mainnet, **immediately quarantine**:
     - Reset contract `trustLevel` to `'unverified'`.
     - Set quarantine flag in `provenance.metadata.quarantined = true`.
     - Invalidate API cache so untrusted names or templates are not served.
3. **Investigation (`investigating`)**:
   - Check on-chain WASM hash: verify contract deployment transaction on Stellar ledger.
   - Check source repository: match commit SHA and compile reproducible WASM via `soroban contract build --package ...`.
   - Validate author cryptographic signature: match submitter address against contract admin/deployer key.
4. **Arbitration (`arbitration`)**:
   - For contested high-value protocols (DeFi DEXes, lending pools, stablecoins), escalate to maintainer review council.
   - Require cryptographically signed statement from deployer key or GitHub organization DNS domain verification.
5. **Resolution (`resolved` or `dismissed`)**:
   - **If Valid**: Upsert correct metadata with elevated `trustLevel` (`verified_publisher` or `canonical`), update `provenance` with audit notes, and publish.
   - **If Invalid/Spurious**: Dismiss dispute with written reason.
   - Either party may appeal if new on-chain or cryptographic evidence emerges (`dismissed -> opened`).

---

## 4. Network Triage Matrix

Priority routing differs by network profile:

| Network | Ingestion Priority | Dispute Priority | Failover Tolerances |
| :--- | :---: | :---: | :--- |
| **Mainnet** | Real-time (strict SLO < 5s) | P0 for spoofing; P2 standard | Hot-standby replica, instant RPC failover |
| **Testnet** | Best-effort (SLO < 30s) | P2 standard | Automated failover; transient resets tolerated during network upgrades |
| **Devnet** | Local / sandbox | P3 backlog | Single node; re-initialized on demand |

---

## 5. Post-Incident Review (PIR) Template

Every P0 and P1 incident requires a Post-Incident Review published within 72 hours:

```markdown
# Incident Postmortem: [Date] - [Short Description]

## Incident Summary
* **Severity**: P0 / P1
* **Duration**: Start time - End time (Total downtime in minutes)
* **Impact**: Total requests affected, affected endpoints/subsystems
* **Incident Commander**: @handle

## Root Cause Analysis (5 Whys)
1. Why did the outage occur?
2. Why was it not caught by CI/staging?
3. Why did automated failover not prevent impact?
4. ...

## Timeline (UTC)
* `12:00` - Initial alert triggered.
* `12:05` - On-call engineer paged and acknowledged.
* `12:15` - Mitigation runbook applied.
* `12:30` - Recovery verified across API replicas.

## Action Items & Preventive Measures
* [ ] Fix underlying bug (Owner, PR link, Due date)
* [ ] Add automated monitoring / alert rule (Owner, Due date)
* [ ] Update runbook documentation (Owner, Due date)
```
