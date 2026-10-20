# Structured Error Reporting with Sensitive-Field Redaction

This document specifies the structured error reporting system and automatic credential redaction mechanism in the Soroban Smart Block Explorer backend.

## 1. Overview and Security Goals

Errors occurring in the API layer, indexer pipelines, or background workers can inadvertently contain confidential data, such as:

- Stellar secret seed keys (`S...` 56-character private account keys)
- Database connection strings containing passwords
- Bearer tokens, JWTs, and API keys
- Authorization headers and session cookies
- Sensitive payload parameters (passwords, tokens, private keys)
- PII such as email addresses

The structured error reporting subsystem (`src/utils/structuredErrorReporter.ts`) guarantees that:

1. **Zero Secret Leakage**: Sensitive credentials and patterns are redacted prior to response serialization and log emissions.
2. **Deterministic Fingerprinting**: Errors are hashed using normalized code and stack locations into 16-character hexadecimal fingerprints for aggregation and alert deduplication.
3. **Structured Context**: Error telemetry captures machine-readable context (`requestId`, `errorId`, `fingerprint`, `severity`, `statusCode`, `network`, `route`).

---

## 2. Redaction Engine & Pattern Specifications

### Pattern Redaction

Strings in error messages, stack traces, and log context are filtered through high-priority regex patterns:

| Secret Category                 | Pattern / Format                                  | Replacement                          |
| ------------------------------- | ------------------------------------------------- | ------------------------------------ |
| **Stellar Secret Key**          | `S[A-Z2-7]{55}`                                   | `[REDACTED]`                         |
| **Database Connection Strings** | `postgres://user:pass@host/db`                    | `postgres://user:[REDACTED]@host/db` |
| **Bearer Token**                | `Bearer <token>`                                  | `Bearer [REDACTED]`                  |
| **JWT Token**                   | `eyJ...` (base64url 3-part token)                 | `[REDACTED]`                         |
| **API Keys**                    | `sk-...` (OpenAI), `AKIA...` (AWS)                | `[REDACTED]`                         |
| **Private Keys**                | `-----BEGIN PRIVATE KEY-----` or `0x[a-f0-9]{64}` | `[REDACTED]`                         |
| **Email Addresses**             | `user@example.com`                                | `[REDACTED]`                         |

### Property Key Blocklist

When objects (such as request payloads, headers, query params, or error metadata) are serialized into logs or responses, keys matching any of the following names (case-insensitive, ignoring underscores and hyphens) have their values replaced with `[REDACTED]`:

- `password`, `passwd`, `pwd`
- `secret`, `token`, `bearer`
- `apikey`, `api_key`
- `auth`, `authorization`, `cookie`, `set-cookie`
- `seed`, `privatekey`, `private_key`
- `databaseurl`, `database_url`
- `adminapikey`, `jwtsecret`, `wssecret`, `webhooksecret`
- `passphrase`

Recursion depth is capped at 10 levels with circular reference tracking to avoid stack overflow on self-referential error objects.

---

## 3. Structured Error Schema

API error responses emit standardized JSON payloads conforming to `StructuredErrorResponse`:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid transaction signature for account GABC... [REDACTED]",
    "details": [
      {
        "field": "secretKey",
        "issue": "[REDACTED]"
      }
    ]
  },
  "meta": {
    "requestId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "timestamp": "2026-10-19T01:00:00.000Z",
    "errorId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "fingerprint": "a3f8b91c20d7e6f4"
  }
}
```

### HTTP Response Headers

Every error response emits correlation headers:

- `X-Request-Id`: Request correlation identifier.
- `X-Error-Fingerprint`: 16-character deterministic error group fingerprint.

---

## 4. Programmatic Usage in Background & Indexer Workloads

Indexer pipelines and background jobs can construct structured reports using `reportStructuredError`:

```typescript
import { reportStructuredError } from './utils/structuredErrorReporter';
import { logger } from './logger';

try {
  await indexLedger(ledgerSequence);
} catch (err) {
  const report = reportStructuredError(err, {
    component: 'indexer',
    network: config.stellarNetwork,
  });

  logger.error('Indexer batch failed', report);
}
```

---

## 5. Compatibility, Rollout, and Network-Specific Implications

- **Compatibility**: The structured error format is completely backward compatible with existing API clients. All previous top-level fields (`success`, `error.code`, `error.message`, `meta.requestId`) are preserved. Additive fields (`meta.fingerprint`, `meta.errorId`, `X-Error-Fingerprint`) enrich client telemetry without breaking strict parsers.
- **Rollout**: No database migration or configuration changes are required. Redaction is enforced synchronously on all log and response pathways.
- **Network Scope**: Redaction applies identically across `mainnet`, `testnet`, and `devnet`. Stellar secret seeds (`S...`) are strictly masked on all networks.
