# Contract Metadata Provenance and Trust Levels

## 1. Overview and Motivation

As Soroban smart contracts expand across DeFi, governance, and gaming, metadata (ABI definitions, contract descriptions, function templates, and protocol keys) submitted by developers and third parties must have rigorous origin tracking and verification tiers.

Without provenance and trust classification, consumers of explorer APIs cannot differentiate between:
1. An unverified community ABI submission.
2. An official, cryptographically signed contract metadata payload from the original protocol author or audited repository.

This feature introduces a structured **trust level hierarchy** and **provenance attestation recording** across the contract registry, submission moderation pipeline, and public REST APIs.

---

## 2. Trust Level Hierarchy

Trust levels form a strict total order from unverified community input to official foundation deployments:

| Trust Level | Hierarchy Rank | Description | Verification Requirements |
| :--- | :---: | :--- | :--- |
| `unverified` | 0 | Default baseline for public submissions | Matches observed indexed transactions or events on-chain, but lacks publisher identity verification. |
| `community` | 1 | Community-moderated or vetted submissions | Peer-reviewed by ecosystem contributors or developer portal verified accounts. |
| `verified_publisher` | 2 | Cryptographically or domain-verified protocol publisher | Source repository verified, commit SHA matched to compiled WASM hash, or signed cryptographic attestation provided. |
| `canonical` | 3 | Official reference implementation for a protocol group | Designates reference protocol implementations linked across networks (`isCanonical: true`). |
| `official` | 4 | Stellar Foundation / Network Core contracts | System contracts, native asset bridges, and protocol-level utility contracts. |

```typescript
export type TrustLevel = 'unverified' | 'community' | 'verified_publisher' | 'canonical' | 'official';

export const TRUST_LEVEL_HIERARCHY: Record<TrustLevel, number> = {
  unverified: 0,
  community: 1,
  verified_publisher: 2,
  canonical: 3,
  official: 4,
};
```

---

## 3. Provenance Attestation Schema

Provenance captures the origin, audit trail, and cryptographic proof of a contract's metadata:

```typescript
export interface ContractMetadataProvenance {
  /** Ingestion source: github, gitlab, cli, developer_portal, soroban_registry_audit, manual */
  source?: string;
  /** Canonical source code repository */
  repoUrl?: string;
  /** Git commit hash corresponding to the deployed contract build */
  commitHash?: string;
  /** Verified publisher or submitter identity identifier */
  submitterIdentity?: string;
  /** URL to public attestation or verification certificate */
  attestationUrl?: string;
  /** Cryptographic signature over the submitted metadata or WASM hash */
  signature?: string;
  /** Stellar or public key address of the signer */
  signerAddress?: string;
  /** Verification or attestation timestamp in ISO format */
  verifiedAt?: string;
  /** Maintainer or reviewer notes */
  notes?: string;
  /** Arbitrary structured verification metadata */
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}
```

---

## 4. Moderation & Publication Lifecycle

```
[Developer Submission]
         │  POST /contracts/abi-submissions
         │  (payload + optional trustLevel & provenance)
         ▼
[Pending Moderation Queue]
         │  Indexed transaction/event validation
         │  Admin Review: POST /admin/contract-abi-submissions/:id/approve
         │  (Admin can elevate trustLevel or append audit notes)
         ▼
[Approved Submission]
         │  POST /admin/contract-abi-submissions/:id/publish
         ▼
[Contract Registry Upsert]
   ├─► Contract (canonical record): stores canonical trustLevel & provenance
   └─► ContractNetwork (deployment record): stores network-scoped trustLevel & provenance
```

1. **Submission (`POST /contracts/abi-submissions`)**:
   - Submissions default to `trustLevel: 'unverified'`.
   - Verified developers may submit with `provenance` containing their repo, commit SHA, and signature.
   - Initial state is recorded in `ContractAbiSubmission` alongside content hashes and validation ledger.

2. **Moderation Review (`POST /admin/contract-abi-submissions/:id/approve`)**:
   - Administrators review the submitted ABI against indexed activity.
   - Maintainers can upgrade the `trustLevel` (e.g., from `unverified` to `verified_publisher` or `canonical`) and append reviewer notes to `provenance`.

3. **Registry Publication (`POST /admin/contract-abi-submissions/:id/publish`)**:
   - When an approved submission is published, its `trustLevel` and `provenance` are atomically written to both:
     - `Contract` (canonical record, when publishing the canonical address).
     - `ContractNetwork` (network-specific deployment record).

4. **Direct Registration (`POST /contracts`)**:
   - Automated CI/CD pipelines and internal indexers can supply `trustLevel` and `provenance` directly when calling `registerContractMetadata`.

---

## 5. API Endpoints

### 5.1 Submit Contract ABI
`POST /contracts/abi-submissions`
```json
{
  "address": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  "network": "testnet",
  "name": "Soroban Token",
  "trustLevel": "verified_publisher",
  "provenance": {
    "source": "github",
    "repoUrl": "https://github.com/stellar/soroban-examples",
    "commitHash": "8f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a",
    "submitterIdentity": "stellar-dev",
    "signature": "0x4b7c...",
    "signerAddress": "GA7N..."
  },
  "abi": {
    "functions": [
      {
        "name": "transfer",
        "inputs": [
          { "name": "to", "type": "Address" },
          { "name": "amount", "type": "i128" }
        ]
      }
    ]
  }
}
```

### 5.2 Approve Submission (Admin)
`POST /admin/contract-abi-submissions/:id/approve`
```json
{
  "reviewNote": "Verified against GitHub commit and on-chain bytecode.",
  "trustLevel": "verified_publisher",
  "provenance": {
    "notes": "Bytecode hash matched wasm-opt output.",
    "verifiedAt": "2026-10-19T22:00:00.000Z"
  }
}
```

### 5.3 Fetch Contract Metadata
`GET /contracts/:address`
```json
{
  "address": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  "name": "Soroban Token",
  "trustLevel": "verified_publisher",
  "provenance": {
    "source": "github",
    "repoUrl": "https://github.com/stellar/soroban-examples",
    "commitHash": "8f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a"
  },
  "networkDeployments": [
    {
      "address": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      "network": "testnet",
      "trustLevel": "verified_publisher",
      "provenance": {
        "source": "github",
        "repoUrl": "https://github.com/stellar/soroban-examples"
      }
    }
  ]
}
```

---

## 6. Database Migration & Schema Reference

Migration `20261019000001_contract_metadata_provenance_trust`:
- `Contract`: adds `trustLevel VARCHAR(64) DEFAULT 'unverified'` and `provenance JSONB`.
- `ContractNetwork`: adds `trustLevel VARCHAR(64) DEFAULT 'unverified'` and `provenance JSONB`.
- `ContractAbiSubmission`: adds `trustLevel VARCHAR(64) DEFAULT 'unverified'` and `provenance JSONB`.
- Adds index `contract_abi_submissions_trust_level_idx` on `ContractAbiSubmission(trustLevel)`.
- Backward-compatible: existing records default to `'unverified'`.
