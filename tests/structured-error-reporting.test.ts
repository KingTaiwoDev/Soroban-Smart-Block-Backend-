process.env.TESTNET_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  redactSensitiveText,
  redactSensitiveObject,
  createErrorFingerprint,
  reportStructuredError,
  REDACTED_MARKER,
} from '../src/utils/structuredErrorReporter';

const docPath = path.resolve(__dirname, '../docs/structured-error-reporting.md');
const reportingDoc = readFileSync(docPath, 'utf8');

describe('Structured Error Reporting — Text Redaction', () => {
  it('redacts Stellar secret seed keys (S followed by 55 base32 chars)', () => {
    const raw =
      'Failed to sign transaction with seed SBVW5Q4UHY2QJXXJ2S3P27FVDOGJFFL343N745ODK6C3K3VNJV3PQAAA';
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toContain('SBVW5Q4UHY2QJXXJ2S3P27FVDOGJFFL343N745ODK6C3K3VNJV3PQAAA');
    expect(redacted).toContain(REDACTED_MARKER);
  });

  it('redacts database passwords while preserving host and database target', () => {
    const raw =
      'Connection refused to postgresql://soroban_user:SuperSecretPassword123@db.prod.internal:5432/soroban_db';
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toContain('SuperSecretPassword123');
    expect(redacted).toContain(
      'postgresql://soroban_user:[REDACTED]@db.prod.internal:5432/soroban_db',
    );
  });

  it('redacts Bearer tokens and Authorization headers', () => {
    const raw1 =
      'Authorization header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeak';
    const raw2 = 'authorization = secret_token_xyz_123';
    expect(redactSensitiveText(raw1)).not.toContain('doNotLeak');
    expect(redactSensitiveText(raw2)).not.toContain('secret_token_xyz_123');
  });

  it('redacts OpenAI and AWS API keys', () => {
    const raw = 'OpenAI failed with sk-1234567890abcdef1234567890 and AWS key AKIAIOSFODNN7EXAMPLE';
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toContain('sk-1234567890abcdef1234567890');
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).toContain(REDACTED_MARKER);
  });

  it('redacts private keys (PEM and 64-char Hex)', () => {
    const pem =
      'Error loading key: -----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----';
    const hex = 'Signer key: 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    expect(redactSensitiveText(pem)).toContain(REDACTED_MARKER);
    expect(redactSensitiveText(pem)).not.toContain(
      'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC',
    );
    expect(redactSensitiveText(hex)).toContain(REDACTED_MARKER);
    expect(redactSensitiveText(hex)).not.toContain('0x0123456789abcdef');
  });

  it('redacts email addresses to preserve PII confidentiality', () => {
    const raw = 'User alice.doe@example.com is unauthorized';
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toContain('alice.doe@example.com');
    expect(redacted).toContain(REDACTED_MARKER);
  });

  it('preserves clean non-sensitive text untouched', () => {
    const clean = 'Transaction tx123 submitted to ledger 12345 successfully';
    expect(redactSensitiveText(clean)).toBe(clean);
  });
});

describe('Structured Error Reporting — Object Redaction', () => {
  it('masks values for sensitive property keys in nested objects', () => {
    const payload = {
      user: {
        id: 'usr_123',
        password: 'PlainTextPassword123!',
        jwt_secret: 'SecretJWTKeyThatMustNotBeLogged',
        auth: 'Bearer my_token',
      },
      operation: 'login',
    };

    const sanitized = redactSensitiveObject(payload);
    expect(sanitized.user.id).toBe('usr_123');
    expect(sanitized.operation).toBe('login');
    expect(sanitized.user.password).toBe(REDACTED_MARKER);
    expect(sanitized.user.jwt_secret).toBe(REDACTED_MARKER);
    expect(sanitized.user.auth).toBe(REDACTED_MARKER);
  });

  it('handles circular references gracefully without throwing', () => {
    const circular: Record<string, unknown> = { name: 'test' };
    circular.self = circular;

    expect(() => redactSensitiveObject(circular)).not.toThrow();
    const result = redactSensitiveObject(circular);
    expect(result.self).toBe('[Circular]');
  });

  it('preserves arrays while redacting items within them', () => {
    const list = [{ apiKey: 'sk-1234567890abcdef12345' }, { username: 'developer1' }];
    const sanitized = redactSensitiveObject(list);
    expect(sanitized[0].apiKey).toBe(REDACTED_MARKER);
    expect(sanitized[1].username).toBe('developer1');
  });

  it('handles null, undefined, and non-object primitives', () => {
    expect(redactSensitiveObject(null)).toBeNull();
    expect(redactSensitiveObject(undefined)).toBeUndefined();
    expect(redactSensitiveObject(42)).toBe(42);
    expect(redactSensitiveObject(true)).toBe(true);
  });
});

describe('Structured Error Reporting — Deterministic Fingerprinting', () => {
  it('generates identical fingerprints for errors with same structure and dynamic identifiers', () => {
    const fp1 = createErrorFingerprint(
      'NOT_FOUND',
      'Resource with id 12345678-1234-1234-1234-1234567890ab at timestamp 2026-10-19T01:00:00.000Z not found',
    );
    const fp2 = createErrorFingerprint(
      'NOT_FOUND',
      'Resource with id 87654321-4321-4321-4321-ba0987654321 at timestamp 2026-10-19T02:30:00.000Z not found',
    );

    expect(fp1).toHaveLength(16);
    expect(fp1).toBe(fp2);
  });

  it('generates different fingerprints for distinct error codes', () => {
    const fpValidation = createErrorFingerprint('VALIDATION_ERROR', 'Invalid parameter');
    const fpInternal = createErrorFingerprint('INTERNAL_ERROR', 'Invalid parameter');

    expect(fpValidation).not.toBe(fpInternal);
  });
});

describe('Structured Error Reporting — reportStructuredError helper', () => {
  it('builds a complete structured error report with redacted fields and context', () => {
    const err = new Error('Database password was postgresql://user:SecretPass@db.internal/db');
    const report = reportStructuredError(
      err,
      {
        component: 'indexer',
        route: '/sync',
        method: 'POST',
      },
      {
        apiKey: 'sk-1234567890abcdef1234567890',
        safeInfo: 'ok',
      },
    );

    expect(report.errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.timestamp).toBeDefined();
    expect(report.code).toBe('INTERNAL_ERROR');
    expect(report.message).not.toContain('SecretPass');
    expect(report.message).toContain(REDACTED_MARKER);
    expect(report.fingerprint).toHaveLength(16);
    expect(report.context.component).toBe('indexer');
    expect(report.metadata?.apiKey).toBe(REDACTED_MARKER);
    expect(report.metadata?.safeInfo).toBe('ok');
  });
});

describe('Structured Error Reporting — Express errorHandler Integration', () => {
  it('sanitizes sensitive data in error responses and attaches fingerprint header', async () => {
    const app = express();
    app.use(express.json());

    const { errorHandler, ValidationError } = await import('../src/middleware/errorHandler');

    app.get('/api/test-secret-leak', () => {
      throw new ValidationError(
        'Failed for seed SBVW5Q4UHY2QJXXJ2S3P27FVDOGJFFL343N745ODK6C3K3VNJV3PQAAA',
        [
          {
            field: 'secretKey',
            issue: 'Invalid seed SBVW5Q4UHY2QJXXJ2S3P27FVDOGJFFL343N745ODK6C3K3VNJV3PQAAA',
          },
        ],
      );
    });

    app.use(errorHandler);

    const res = await request(app).get('/api/test-secret-leak');

    expect(res.status).toBe(400);
    expect(res.headers['x-error-fingerprint']).toBeDefined();
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).not.toContain(
      'SBVW5Q4UHY2QJXXJ2S3P27FVDOGJFFL343N745ODK6C3K3VNJV3PQAAA',
    );
    expect(res.body.error.message).toContain(REDACTED_MARKER);
    expect(res.body.error.details[0].issue).not.toContain(
      'SBVW5Q4UHY2QJXXJ2S3P27FVDOGJFFL343N745ODK6C3K3VNJV3PQAAA',
    );
    expect(res.body.error.details[0].issue).toContain(REDACTED_MARKER);
    expect(res.body.meta.fingerprint).toBeDefined();
    expect(res.body.meta.errorId).toBeDefined();
  });
});

describe('Structured Error Reporting — Documentation Alignment', () => {
  it('documents Stellar secret seed and database URL redaction rules', () => {
    expect(reportingDoc).toContain('S[A-Z2-7]{55}');
    expect(reportingDoc).toContain('Database Connection Strings');
    expect(reportingDoc).toContain('Bearer');
    expect(reportingDoc).toContain('X-Error-Fingerprint');
  });

  it('documents non-breaking client compatibility and multi-network scope', () => {
    expect(reportingDoc).toContain('Compatibility');
    expect(reportingDoc).toContain('Network Scope');
    expect(reportingDoc).toContain('mainnet');
    expect(reportingDoc).toContain('testnet');
  });
});
