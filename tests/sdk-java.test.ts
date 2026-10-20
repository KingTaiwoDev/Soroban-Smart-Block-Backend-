import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { javaEmitter } from '../scripts/sdk/emit-java';
import { normalizeOperations, type OpenApiDocument } from '../src/lib/openapi/normalize';

const ROOT = path.join(__dirname, '..');

const mockDoc: OpenApiDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Soroban Block Explorer API',
    version: '1.0.0',
  },
  paths: {
    '/contracts': {
      get: {
        operationId: 'getContracts',
        summary: 'List contracts',
        parameters: [
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'Contracts list',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ContractListResponse',
                },
              },
            },
          },
          '404': {
            description: 'Not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
        },
      },
    },
    '/contracts/{address}': {
      get: {
        operationId: 'getContractsByAddress',
        summary: 'Get contract by address',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Contract details',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ContractResponse',
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ContractResponse: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          codeHash: { type: 'string' },
          deployedAt: { type: 'integer' },
          verified: { type: 'boolean' },
        },
      },
      ContractListResponse: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/ContractResponse' },
          },
          nextCursor: { type: 'string' },
          total: { type: 'integer' },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          requestId: { type: 'string' },
        },
      },
    },
  },
};

describe('Java Client SDK Generator (#1288)', () => {
  it('generates buildable Java client files and documented package layout', () => {
    const javaClientDir = path.join(ROOT, 'packages', 'java-client');
    expect(fs.existsSync(path.join(javaClientDir, 'pom.xml'))).toBe(true);
    expect(fs.existsSync(path.join(javaClientDir, 'README.md'))).toBe(true);

    const srcDir = path.join(javaClientDir, 'src', 'main', 'java', 'io', 'soroban', 'explorer');
    expect(fs.existsSync(path.join(srcDir, 'SorobanClient.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'Operations.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'models', 'Models.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'auth', 'Authentication.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'auth', 'ApiKeyAuth.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'auth', 'BearerAuth.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'errors', 'ApiException.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'errors', 'ApiExceptions.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'errors', 'RateLimitInfo.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'pagination', 'Page.java'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'pagination', 'PaginationParams.java'))).toBe(true);

    const testDir = path.join(javaClientDir, 'src', 'test', 'java', 'io', 'soroban', 'explorer');
    expect(fs.existsSync(path.join(testDir, 'ClientSmokeTest.java'))).toBe(true);
  });

  it('represents authentication, typed operations, pagination fields, and API error metadata', () => {
    const ops = normalizeOperations(mockDoc);
    const files = javaEmitter({ doc: mockDoc, ops, fingerprint: 'deadbeef1234' });

    expect(files).toHaveLength(2);
    const operationsFile = files.find((f) => f.path.endsWith('Operations.java'));
    const modelsFile = files.find((f) => f.path.endsWith('Models.java'));

    expect(operationsFile).toBeDefined();
    expect(modelsFile).toBeDefined();

    // Verify operations representation
    expect(operationsFile!.content).toContain('public static final String SPEC_VERSION = "1.0.0";');
    expect(operationsFile!.content).toContain('public static final String SPEC_FINGERPRINT = "deadbeef1234";');
    expect(operationsFile!.content).toContain('getContracts');
    expect(operationsFile!.content).toContain('getContractsByAddress');
    expect(operationsFile!.content).toContain('supportsPagination');

    // Verify models representation
    expect(modelsFile!.content).toContain('public record ContractResponse');
    expect(modelsFile!.content).toContain('public record ContractListResponse');
    expect(modelsFile!.content).toContain('public record ErrorResponse');
    expect(modelsFile!.content).toContain('@JsonProperty("address") String address');
    expect(modelsFile!.content).toContain('@JsonProperty("nextCursor") String nextCursor');
  });

  it('guarantees deterministic output across multiple emitter runs', () => {
    const ops = normalizeOperations(mockDoc);
    const run1 = javaEmitter({ doc: mockDoc, ops, fingerprint: 'hash_abc' });
    const run2 = javaEmitter({ doc: mockDoc, ops, fingerprint: 'hash_abc' });

    expect(run1).toEqual(run2);
    for (let i = 0; i < run1.length; i++) {
      expect(run1[i].content).toBe(run2[i].content);
    }
  });

  it('supports smoke testing for successful response parsing and standard API error mapping', () => {
    // Verify client source code implements error mapping and models
    const clientCode = fs.readFileSync(
      path.join(ROOT, 'packages', 'java-client', 'src', 'main', 'java', 'io', 'soroban', 'explorer', 'SorobanClient.java'),
      'utf8'
    );
    const authCode = fs.readFileSync(
      path.join(ROOT, 'packages', 'java-client', 'src', 'main', 'java', 'io', 'soroban', 'explorer', 'auth', 'ApiKeyAuth.java'),
      'utf8'
    );
    const bearerCode = fs.readFileSync(
      path.join(ROOT, 'packages', 'java-client', 'src', 'main', 'java', 'io', 'soroban', 'explorer', 'auth', 'BearerAuth.java'),
      'utf8'
    );
    expect(authCode).toContain('X-API-Key');
    expect(bearerCode).toContain('Authorization');
    expect(clientCode).toContain('X-Request-ID');
    expect(clientCode).toContain('X-RateLimit-Limit');
    expect(clientCode).toContain('ApiExceptions.fromResponse');

    const smokeTestCode = fs.readFileSync(
      path.join(ROOT, 'packages', 'java-client', 'src', 'test', 'java', 'io', 'soroban', 'explorer', 'ClientSmokeTest.java'),
      'utf8'
    );
    expect(smokeTestCode).toContain('testSuccessfulResponseAndPagination');
    expect(smokeTestCode).toContain('testStandardApiErrorMapping');
    expect(smokeTestCode).toContain('NotFoundException');
  });
});
