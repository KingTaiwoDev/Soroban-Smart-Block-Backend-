# Workload Capacity Model: API and Indexer

This document specifies the operational capacity model for the Soroban Smart Block Explorer backend, covering both user-facing API workloads and background Stellar ledger ingestion (indexer). It defines analytical sizing formulas, benchmark-calibrated resource budgets, scaling thresholds, and network-specific provisioning profiles.

## Overview and Objectives

The capacity model guarantees compliance with service level objectives (SLOs):

- **API Availability & Latency SLO** (`docs/api-slo.md`): 99.5% availability, p95 latency targets:
  - `read`: ≤ 250 ms
  - `write`: ≤ 500 ms
  - `compute`: ≤ 1.5 s
  - `graphql`: ≤ 500 ms
- **Indexer Freshness SLO** (`docs/indexer-freshness-slo.md`):
  - Mainnet & Testnet: ledger lag warning at 50 ledgers, critical at 200 ledgers; freshness warning at 60s, critical at 300s.
  - Recovery Time Objective (RTO): Clear simulated backlogs within $\le 60\text{ minutes}$.

---

## 1. API Workload Model

API traffic is categorized by endpoint classes with distinct computational and database demands:

| Class     | Traffic Share | Typical Endpoints                                       | Mean CPU Core Time ($T_c$) |             Database Calls | Memory / Req |
| --------- | ------------: | ------------------------------------------------------- | -------------------------: | -------------------------: | -----------: |
| `read`    |           70% | `GET /api/v1/transactions`, `GET /api/v1/contracts/:id` |                      12 ms |         1–2 cached/replica |       ~1 MiB |
| `write`   |           15% | POST submissions, webhook configuration                 |                      30 ms |         1–3 primary writes |       ~2 MiB |
| `graphql` |            8% | `/api/graphql` (depth $\le 7$)                          |                      45 ms |          2–5 batch lookups |       ~4 MiB |
| `compute` |            5% | `/simulate`, `/verify`, sandbox, MEV, fraud             |                     180 ms |        2–8 complex queries |      ~25 MiB |
| `batch`   |            2% | `/batch/*` (capped at 2 MiB / 100 items)                |                      90 ms | Multi-item batched queries |       ~8 MiB |

### API Sizing Formula

The number of API container instances ($N_{\text{api}}$) required to sustain a target aggregate request rate ($R_{\text{target}}$) is:

$$N_{\text{api}} = \left\lceil \frac{\sum_{c} (R_{\text{target}} \cdot P_c \cdot T_c)}{U_{\text{target}} \cdot C_{\text{instance}}} \right\rceil$$

Where:

- $P_c$: Proportion of traffic belonging to class $c$.
- $T_c$: Execution core time for class $c$ (in seconds).
- $U_{\text{target}}$: Target sustained CPU utilization ceiling (recommended: **0.70** or 70%).
- $C_{\text{instance}}$: Number of vCPU cores allocated per container instance (standard: **2 vCPUs**).

### API Database Connection Pool Sizing

Each API container maintains an isolated Prisma connection pool:

$$\text{Pool}_{\text{api, total}} = N_{\text{api}} \times \text{ConnectionsPerInstance}$$

Standard container allocation is **10 connections** per 2-vCPU instance. For 4 API instances, this requires 40 connections.

---

## 2. Indexer Workload Model

The indexer runs as a continuous worker process with catch-up concurrency controlled by `INDEXER_CATCHUP_WORKERS` (1 to 32) and `INDEXER_BATCH_SIZE` (1 to 1000).

### Ingestion Profiles

- **Stellar Ledger Ingestion Rate**: A new ledger closes every ~5 seconds ($\lambda_{\text{chain}} = 0.2\text{ ledgers/sec}$ or $17,280\text{ ledgers/day}$).
- **Steady-State Ingestion**: 1 worker handles incoming ledgers under nominal load, consuming $< 5\%$ of 1 vCPU and 1 active DB connection.
- **Catch-up Ingestion**: Triggered when the service starts behind the chain tip or recovers from downtime. Concurrency scales across catch-up workers.

### Catch-up Throughput and Recovery Time

Throughput per worker ($\mu_{\text{worker}}$) depends on ledger density:

$$\mu_{\text{worker}} = \frac{1000\text{ ms}}{T_{\text{fetch}} + T_{\text{decode}} + T_{\text{write}}}$$

Calibrated ledger processing time:

- Mainnet (avg 50 tx/ledger, 4 events/tx): ~$25\text{ ms/ledger}$ $\implies \approx 40\text{ ledgers/sec/worker}$.
- Testnet (avg 10 tx/ledger): ~$15\text{ ms/ledger}$ $\implies \approx 66\text{ ledgers/sec/worker}$.

Total catch-up throughput with $W$ workers:

$$\mu_{\text{catchup}} = W \times \mu_{\text{worker}}$$

Net backlog clearance rate accounts for ongoing chain production ($\lambda_{\text{chain}} = 0.2$):

$$T_{\text{recovery}} = \frac{\Delta \text{Ledgers}}{\mu_{\text{catchup}} - \lambda_{\text{chain}}}$$

### Indexer Database Connection Requirement

$$\text{Pool}_{\text{indexer}} = W_{\text{catchup}} + \text{MonitorConnections} + 2$$

For $W = 4$ workers, the indexer requires **6 database connections**.

---

## 3. Storage Growth Model

Storage requirements combine PostgreSQL tabular storage, pgvector embeddings, and B-tree indexing overhead ($\approx 35\%$):

| Entity         | Record Size | Mainnet Daily Volume |       Daily Growth |      Monthly Growth |
| -------------- | ----------: | -------------------: | -----------------: | ------------------: |
| Ledger Header  |      ~2 KiB |       17,280 ledgers |            35.4 MB |             1.06 GB |
| Transactions   |      ~4 KiB |          ~864,000 tx |            3.54 GB |            106.2 GB |
| Events         |    ~1.5 KiB |    ~3,456,000 events |            5.31 GB |            159.3 GB |
| Index Overhead |        +35% |                    — |            3.22 GB |             96.8 GB |
| **Total**      |           — |                    — | **~12.1 GB / day** | **~363 GB / month** |

---

## 4. Provisioning Sizing Matrices

### Mainnet Provisioning (Production)

| Load Tier    | Target API RPS | API Instances (2 vCPU / 4 GB) | Indexer Workers | DB Connections (API + Indexer) | Recommended PostgreSQL         |
| ------------ | -------------: | ----------------------------: | --------------: | -----------------------------: | ------------------------------ |
| **Standard** |        100 RPS |                   2 instances |       4 workers |             $20 + 6 = 26$ conn | 4 vCPU, 16 GB RAM, 500 GB NVMe |
| **High**     |        500 RPS |                   6 instances |       8 workers |            $60 + 10 = 70$ conn | 8 vCPU, 32 GB RAM, 2 TB NVMe   |
| **Peak**     |      1,500 RPS |                  16 instances |      16 workers |          $160 + 18 = 178$ conn | 16 vCPU, 64 GB RAM, 5 TB NVMe  |

### Testnet Provisioning

- Target API RPS: 50 RPS.
- API Instances: 1–2 instances.
- Indexer Workers: 2–4 workers.
- Daily Storage Growth: ~2.4 GB / day.

### Devnet Provisioning

- Target API RPS: 10 RPS.
- API Instances: 1 instance.
- Indexer Workers: 1 worker.
- Daily Storage Growth: $< 100\text{ MB / day}$.

---

## 5. Scaling Triggers and Degradation Runbook

### Horizontal Pod Autoscaling (HPA) Triggers

1. **API CPU Utilization**: Scale up when sustained CPU utilization exceeds **70%** for 2 minutes. Scale down when $< 30\%$ for 10 minutes.
2. **API p95 Latency**: Scale up when read class p95 exceeds **200 ms** (80% of SLO budget).
3. **Indexer Lag**:
   - If lag exceeds **50 ledgers**, auto-scale `INDEXER_CATCHUP_WORKERS` from 4 to 8.
   - If lag exceeds **200 ledgers**, alert on-call and scale workers to 16.

### Under-Provisioning Failure Scenarios

- **Database Pool Saturation**: When API instances exceed database connection limits, queries queue and timeout ($504$ / $500$). The capacity calculator `validateCapacityPlan` detects when connection demand exceeds maximum pool size.
- **Indexer Ingestion Deficit**: If worker throughput falls below $0.2\text{ ledgers/sec}$ ($\mu_{\text{catchup}} \le \lambda_{\text{chain}}$), the backlog will grow indefinitely.

---

## 6. Automated Validation and Implementation

The model is programmatically implemented in `src/utils/capacityModel.ts` and verified by automated regression tests in `tests/capacity-model.test.ts`. Capacity planning tools can import `calculateApiCapacity`, `calculateIndexerCapacity`, and `validateCapacityPlan` to validate proposed infrastructure budgets before deployment.
