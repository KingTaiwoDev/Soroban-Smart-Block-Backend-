# Community-Driven ABI Marketplace & Smart Contract Registry

## Overview

The Community-Driven ABI Marketplace enables crowdsourced submission, verification, curation, and discovery of smart contract ABIs on Soroban. It solves the cold-start problem where unverified contracts lack human-readable function interfaces.

Key capabilities:
1. **ABI Submission & Evidence Tracking**: Submission with wallet authentication, evidence sources (manual, decompiled, GitHub, official, tx analysis), confidence ratings.
2. **Auto-Verification via Transaction Simulation**: Simulates proposed ABIs against historical transactions. Over 95% coverage auto-approves; 80–95% triggers community review; <80% rejects.
3. **Reputation-Weighted Community Voting**: Quadratic and reputation-boosted voting based on developer activity, audit history, review accuracy, and token holding.
4. **Escrow Bounty System**: Creators fund bounties in XLM/tokens to incentivize interface submissions. Escrows release upon active verification or refund if expired.
5. **Multi-Dimensional Quality Scoring**: Composite 0–100 score weighing Transaction Coverage (30%), Community Verification (25%), Source Trust (20%), Stability (15%), and Bug Reports (10%).
6. **Semantic Versioning & Diffing**: Identifies added, removed, and modified functions/parameters and detects breaking changes across contract upgrades.
7. **Automated Interface Discovery**: Proposes candidate ABIs for uncatalogued contracts using common Soroban interface heuristics.
8. **Multi-Format Code Generation**: Exports ABIs in OpenRPC 1.3, TypeScript client interfaces, and Rust Soroban SDK traits.

---

## Architecture & Data Flow

```
[Contract Deployer / Community Member]
                │
                ▼
   POST /api/v1/abi-marketplace/submissions
                │
                ├──> 1. Transaction Simulation Engine
                │       ├── Coverage > 95% ──> auto_verified
                │       ├── Coverage 80-95% ─> community_verify (pending)
                │       └── Coverage < 80% ──> rejected
                │
                ├──> 2. Reputation Voting (POST .../vote)
                │       ├── Weighted Upvotes > 10 & Ratio > 75% ──> community_verified
                │       └── Weighted Downvotes > 10 | Ratio < 25% ─> rejected
                │
                ├──> 3. Quality Scorer (0 - 100)
                │       └── Highest score becomes 'active'
                │
                └──> 4. Escrow Bounty Release
                        └── Unlocks bounty to submitter
```

---

## API Reference

### 1. Submissions

#### `POST /api/v1/abi-marketplace/submissions`
Submit an ABI for verification.
Headers: `x-wallet-address: <Stellar-Address>`
Payload:
```json
{
  "contractAddress": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  "version": "1.0",
  "abi": {
    "functions": [
      {
        "name": "transfer",
        "inputs": [
          { "name": "from", "type": "address" },
          { "name": "to", "type": "address" },
          { "name": "amount", "type": "i128" }
        ],
        "stateMutability": "nonpayable"
      }
    ]
  },
  "evidence": {
    "sourceType": "github",
    "sources": [{ "type": "url", "value": "https://github.com/example/contract" }],
    "confidence": "high",
    "notes": "Verified source code"
  }
}
```

#### `GET /api/v1/abi-marketplace/submissions`
Query parameters:
- `contractAddress`: Filter by contract address
- `status`: `pending`, `auto_verified`, `community_verified`, `active`, `rejected`, `superseded`
- `page`: Page index (default: 1)
- `limit`: Page limit (default: 25)

#### `GET /api/v1/abi-marketplace/submissions/:id`
Retrieves full submission details with vote summaries and quality scoring.

---

### 2. Simulation & Verification

#### `POST /api/v1/abi-marketplace/submissions/:id/simulate`
Triggers simulation against 50+ transactions.

#### `GET /api/v1/abi-marketplace/submissions/:id/coverage-report`
Returns transaction coverage percentage, verdict, and mismatches:
```json
{
  "submissionId": "uuid",
  "totalTransactions": 50,
  "matched": 48,
  "mismatched": 1,
  "unknown": 1,
  "coveragePercentage": 96.0,
  "verdict": "auto_verified",
  "mismatches": []
}
```

---

### 3. Voting & Reputation

#### `POST /api/v1/abi-marketplace/submissions/:id/vote`
Cast a weighted vote.
```json
{
  "voterAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "vote": true,
  "reason": "Verified against on-chain transaction hashes"
}
```

#### `GET /api/v1/abi-marketplace/reviewers/leaderboard`
Leaderboard of top reviewers ranked by accuracy and reviewer score.

---

### 4. Escrow Bounties

#### `POST /api/v1/abi-marketplace/bounties`
Create a bounty:
```json
{
  "contractAddress": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  "creatorAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "rewardAmount": "250",
  "rewardToken": "XLM",
  "description": "Need verified interface for DEX aggregator",
  "expiresInDays": 30
}
```

#### `POST /api/v1/abi-marketplace/bounties/:id/claim`
Claim a bounty:
```json
{
  "submissionId": "uuid"
}
```

#### `POST /api/v1/abi-marketplace/bounties/:id/refund`
Refund an expired or unfulfilled bounty.

---

### 5. Quality Score & Semantic Diff

#### `GET /api/v1/abi-marketplace/contracts/:address/quality`
Returns multi-dimensional quality score and breakdown:
- Transaction Coverage: 30%
- Community Verification: 25%
- Source Trust: 20%
- Stability: 15%
- Bug Reports: 10%

#### `GET /api/v1/abi-marketplace/contracts/:address/versions/diff?from=:id1&to=:id2`
Returns semantic diff:
```json
{
  "addedFunctions": ["mint"],
  "removedFunctions": [],
  "changedFunctions": [],
  "addedEvents": ["MintEvent"],
  "removedEvents": [],
  "compatibility": "non_breaking"
}
```

---

### 6. Code Generation & Export

#### `GET /api/v1/abi-marketplace/contracts/:address/abi/export?format=openrpc|typescript|rust|json`
Returns generated client bindings or specifications.

---

## Service Level Objectives (SLOs) & Error Budgets

| Service / Endpoint | Latency Target (p95) | Availability Target | Error Budget (Monthly) |
| :--- | :--- | :--- | :--- |
| `GET /submissions` | < 30ms | 99.95% | 21.6 minutes |
| `POST /submissions` | < 150ms | 99.90% | 43.2 minutes |
| `POST /simulate` | < 350ms | 99.50% | 3.6 hours |
| `POST /vote` | < 50ms | 99.95% | 21.6 minutes |
| `GET /quality` | < 25ms | 99.95% | 21.6 minutes |

---

## Operating Runbook

### Alert: High Simulation Failure Rate
1. Check `/metrics` for `abi_marketplace_operations_total{operation="simulate", outcome="rejected"}`.
2. Verify if the Soroban RPC provider is returning valid transaction ledgers.
3. If specific contracts are failing due to novel XDR types, check telemetry logs in `src/logger.ts`.

### Alert: Bounty Claim Conflict
1. Check escrow status of the bounty: `GET /api/v1/abi-marketplace/bounties/:id`.
2. Confirm the candidate submission is active or community-verified before re-attempting claim.
