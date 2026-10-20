import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  csharpEmitter,
  emitCSharpModels,
  emitCSharpOperations,
  toPascalCase,
  sanitizePropertyName,
} from '../scripts/sdk/emit-csharp';
import { normalizeOperations, type OpenApiDocument } from '../src/lib/openapi/normalize';

const sampleDoc: OpenApiDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Soroban Test API',
    version: '1.2.3',
  },
  paths: {
    '/contracts/{contractId}/events': {
      get: {
        operationId: 'getContractEvents',
        summary: 'List contract events with pagination',
        parameters: [
          {
            name: 'contractId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'cursor',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', format: 'int32' },
          },
        ],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ContractEventsResponse',
                },
              },
            },
          },
        },
      },
    },
    '/transactions': {
      post: {
        operationId: 'postTransaction',
        summary: 'Submit a transaction',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/SubmitTxRequest',
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Accepted',
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ContractEventsResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/EventRecord',
            },
          },
          next_cursor: { type: 'string' },
          total_count: { type: 'integer' },
          is_active: { type: 'boolean' },
          gas_estimate: { type: 'number' },
        },
      },
      EventRecord: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          contract_id: { type: 'string' },
          event_type: { type: 'string' },
          ledger_sequence: { type: 'integer' },
        },
      },
      SubmitTxRequest: {
        type: 'object',
        properties: {
          tx_envelope: { type: 'string' },
          class: { type: 'string' }, // reserved keyword test
          SubmitTxRequest: { type: 'string' }, // enclosing type conflict test
        },
      },
    },
  },
};

describe('C# Client Emitter (Issue #1289)', () => {
  const ops = normalizeOperations(sampleDoc);
  const fingerprint = 'test-sha-1234';

  it('transforms identifiers into safe PascalCase C# properties and handles keywords/conflicts', () => {
    expect(toPascalCase('tx_hash')).toBe('TxHash');
    expect(toPascalCase('contract_id')).toBe('ContractId');
    expect(toPascalCase('123_test')).toBe('P_123Test');

    expect(sanitizePropertyName('class', 'MyClass')).toBe('@Class');
    expect(sanitizePropertyName('event', 'MyClass')).toBe('@Event');
    expect(sanitizePropertyName('SubmitTxRequest', 'SubmitTxRequest')).toBe('SubmitTxRequestValue');
  });

  it('emits strongly typed C# record models with JsonPropertyName attributes', () => {
    const modelsContent = emitCSharpModels(sampleDoc);

    expect(modelsContent).toContain('namespace SorobanExplorer.Client;');
    expect(modelsContent).toContain('public record ContractEventsResponse');
    expect(modelsContent).toContain('[JsonPropertyName("next_cursor")]');
    expect(modelsContent).toContain('public string? NextCursor { get; init; }');
    expect(modelsContent).toContain('[JsonPropertyName("total_count")]');
    expect(modelsContent).toContain('public long? TotalCount { get; init; }');
    expect(modelsContent).toContain('[JsonPropertyName("is_active")]');
    expect(modelsContent).toContain('public bool? IsActive { get; init; }');
    expect(modelsContent).toContain('[JsonPropertyName("gas_estimate")]');
    expect(modelsContent).toContain('public double? GasEstimate { get; init; }');
    expect(modelsContent).toContain('public List<EventRecord>? Data { get; init; }');

    // Keyword & collision sanitization
    expect(modelsContent).toContain('public record SubmitTxRequest');
    expect(modelsContent).toContain('public string? @Class { get; init; }');
    expect(modelsContent).toContain('public string? SubmitTxRequestValue { get; init; }');
  });

  it('emits operation metadata table with path parameters, query parameters, and body types', () => {
    const opsContent = emitCSharpOperations(sampleDoc, ops, fingerprint);

    expect(opsContent).toContain('namespace SorobanExplorer.Client;');
    expect(opsContent).toContain('public static class Operations');
    expect(opsContent).toContain('SpecVersion = "1.2.3";');
    expect(opsContent).toContain('SpecFingerprint = "test-sha-1234";');
    expect(opsContent).toContain('OperationCount = 2;');
    expect(opsContent).toContain('["getContractEvents"] = new OperationMetadata');
    expect(opsContent).toContain('Method = "GET"');
    expect(opsContent).toContain('Path = "/contracts/{contractId}/events"');
    expect(opsContent).toContain('PathParams = new string[] { "contractId" }');
    expect(opsContent).toContain('Name = "cursor"');
    expect(opsContent).toContain('Name = "limit"');
    expect(opsContent).toContain('BodyType = "required"');
  });

  it('produces deterministic output across consecutive generation passes', () => {
    const run1 = csharpEmitter({ doc: sampleDoc, ops, fingerprint });
    const run2 = csharpEmitter({ doc: sampleDoc, ops, fingerprint });

    expect(run1).toHaveLength(2);
    expect(run2).toHaveLength(2);
    expect(run1[0].path).toBe('packages/dotnet-client/src/SorobanExplorer.Client/Models.g.cs');
    expect(run1[1].path).toBe('packages/dotnet-client/src/SorobanExplorer.Client/Operations.g.cs');
    expect(run1[0].content).toBe(run2[0].content);
    expect(run1[1].content).toBe(run2[1].content);
  });

  it('verifies presence of .NET library files and integration example', () => {
    const rootDir = path.resolve(__dirname, '..');
    const csprojPath = path.join(
      rootDir,
      'packages/dotnet-client/src/SorobanExplorer.Client/SorobanExplorer.Client.csproj',
    );
    const clientPath = path.join(
      rootDir,
      'packages/dotnet-client/src/SorobanExplorer.Client/SorobanExplorerClient.cs',
    );
    const errorsPath = path.join(
      rootDir,
      'packages/dotnet-client/src/SorobanExplorer.Client/Errors.cs',
    );
    const paginationPath = path.join(
      rootDir,
      'packages/dotnet-client/src/SorobanExplorer.Client/Pagination.cs',
    );
    const exampleProgram = path.join(
      rootDir,
      'packages/dotnet-client/examples/PaginatedQueryExample/Program.cs',
    );

    expect(fs.existsSync(csprojPath)).toBe(true);
    expect(fs.existsSync(clientPath)).toBe(true);
    expect(fs.existsSync(errorsPath)).toBe(true);
    expect(fs.existsSync(paginationPath)).toBe(true);
    expect(fs.existsSync(exampleProgram)).toBe(true);

    const clientSrc = fs.readFileSync(clientPath, 'utf8');
    expect(clientSrc).toContain('x-api-key');
    expect(clientSrc).toContain('CallAsync<TResponse>');
    expect(clientSrc).toContain('SorobanApiException');

    const paginationSrc = fs.readFileSync(paginationPath, 'utf8');
    expect(paginationSrc).toContain('EnumeratePagesAsync');
    expect(paginationSrc).toContain('PaginatedListResponse');

    const exampleSrc = fs.readFileSync(exampleProgram, 'utf8');
    expect(exampleSrc).toContain('EnumeratePagesAsync');
    expect(exampleSrc).toContain('SorobanExplorerClient');
  });
});
