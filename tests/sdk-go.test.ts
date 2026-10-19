import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { goEmitter } from '../scripts/sdk/emit-go';
import { normalizeOperations, type OpenApiDocument } from '../src/lib/openapi/normalize';

const sampleDoc: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Soroban Explorer API', version: '1.2.3' },
  paths: {
    '/transactions': {
      get: {
        operationId: 'getTransactions',
        summary: 'List transactions',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Successful list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    transactions: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/TransactionSummary' },
                    },
                    nextCursor: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid parameter',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/transactions/{hash}': {
      get: {
        operationId: 'getTransactionsByHash',
        summary: 'Get transaction by hash',
        parameters: [
          { name: 'hash', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Transaction details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TransactionDetails' },
              },
            },
          },
          '404': {
            description: 'Not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiErrorResponse' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      TransactionSummary: {
        type: 'object',
        properties: {
          hash: { type: 'string' },
          status: { type: 'string' },
          ledgerSequence: { type: 'integer' },
        },
        required: ['hash', 'status'],
      },
      TransactionDetails: {
        type: 'object',
        properties: {
          hash: { type: 'string' },
          feeCharged: { type: 'string' },
          successful: { type: 'boolean' },
        },
      },
      ApiErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
};

describe('Go Client SDK Emitter (#1287)', () => {
  it('generates deterministic operations and models files', () => {
    const ops = normalizeOperations(sampleDoc);
    const files = goEmitter({
      doc: sampleDoc,
      ops,
      fingerprint: 'test-fingerprint-123',
    });

    expect(files).toHaveLength(2);
    const [modelsFile, opsFile] = files;

    expect(modelsFile.path).toBe('packages/go-client/models.go');
    expect(opsFile.path).toBe('packages/go-client/operations.go');

    // Models checks
    expect(modelsFile.content).toContain('type TransactionSummary struct');
    expect(modelsFile.content).toContain('Hash string `json:"hash"`');
    expect(modelsFile.content).toContain('LedgerSequence *int64 `json:"ledgerSequence,omitempty"`');
    expect(modelsFile.content).toContain('type TransactionDetails struct');

    // Operations checks
    expect(opsFile.content).toContain('SpecVersion     = "1.2.3"');
    expect(opsFile.content).toContain('SpecFingerprint = "test-fingerprint-123"');
    expect(opsFile.content).toContain('"getTransactions": {');
    expect(opsFile.content).toContain('Method: "GET"');
    expect(opsFile.content).toContain('Path: "/transactions"');
    expect(opsFile.content).toContain('Name: "limit", Type: "integer"');
    expect(opsFile.content).toContain('Name: "cursor", Type: "string"');
    expect(opsFile.content).toContain('"getTransactionsByHash": {');
    expect(opsFile.content).toContain('"hash",');
  });

  it('generated disk files exist and are buildable Go module', () => {
    const goModPath = path.join(__dirname, '../packages/go-client/go.mod');
    const clientPath = path.join(__dirname, '../packages/go-client/client.go');
    const errorsPath = path.join(__dirname, '../packages/go-client/errors.go');
    const opsPath = path.join(__dirname, '../packages/go-client/operations.go');
    const modelsPath = path.join(__dirname, '../packages/go-client/models.go');

    expect(fs.existsSync(goModPath)).toBe(true);
    expect(fs.existsSync(clientPath)).toBe(true);
    expect(fs.existsSync(errorsPath)).toBe(true);
    expect(fs.existsSync(opsPath)).toBe(true);
    expect(fs.existsSync(modelsPath)).toBe(true);

    const goMod = fs.readFileSync(goModPath, 'utf8');
    expect(goMod).toContain('module github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/packages/go-client');
    expect(goMod).toContain('go 1.20');

    const clientCode = fs.readFileSync(clientPath, 'utf8');
    expect(clientCode).toContain('func (c *Client) Call(');
    expect(clientCode).toContain('WithLimit');
    expect(clientCode).toContain('WithCursor');
    expect(clientCode).toContain('X-Api-Key');

    const errorsCode = fs.readFileSync(errorsPath, 'utf8');
    expect(errorsCode).toContain('CategoryValidation');
    expect(errorsCode).toContain('CategoryRateLimit');
    expect(errorsCode).toContain('RetryAfter');
    expect(errorsCode).toContain('ErrorFromResponse');
  });
});
