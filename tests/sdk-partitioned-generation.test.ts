import { describe, it, expect } from 'vitest';
import {
  generatePartitioned,
  PartitionedGenerationError,
  partitionOperations,
  resolveSharedSchemas,
} from '../scripts/sdk/partitioned-generator';
import { generateAll } from '../scripts/sdk/generate';
import { swaggerSpec } from '../src/indexer/swaggerSpec';
import { normalizeOperations, type OpenApiDocument } from '../src/lib/openapi/normalize';

/** Stress fixture generator creating large specs with cross-partition shared schemas. */
function createStressSpec(operationCount: number, sharedSchemaCount: number): OpenApiDocument {
  const paths: Record<string, any> = {};
  const schemas: Record<string, any> = {};

  // Create shared models
  for (let s = 0; s < sharedSchemaCount; s++) {
    schemas[`SharedMeta_${s}`] = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
        version: { type: 'integer', format: 'int32' },
      },
    };
  }

  // Create operations referencing shared models
  for (let i = 0; i < operationCount; i++) {
    const opId = `getStressOp_${String(i).padStart(4, '0')}`;
    const sharedIdx = i % sharedSchemaCount;
    const opModelName = `OpResponse_${i}`;

    schemas[opModelName] = {
      type: 'object',
      properties: {
        resultId: { type: 'string' },
        meta: { $ref: `#/components/schemas/SharedMeta_${sharedIdx}` },
      },
    };

    paths[`/stress/resource/${i}`] = {
      get: {
        operationId: opId,
        summary: `Stress operation ${i}`,
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${opModelName}` },
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: '3.0.0',
    info: {
      title: 'Large Stress Spec',
      version: '2.0.0',
    },
    paths,
    components: {
      schemas,
    },
  };
}

describe('Partitioned SDK Generation (Issue #1293)', () => {
  it('partitions operations by stable chunk boundaries and detects shared schemas', () => {
    const stressDoc = createStressSpec(120, 5);
    const ops = normalizeOperations(stressDoc);
    const partitions = partitionOperations(ops, stressDoc.components?.schemas ?? {}, {
      partitionSize: 30,
      strategy: 'chunk',
    });

    expect(partitions).toHaveLength(4); // 120 / 30 = 4 partitions
    expect(partitions[0].operations).toHaveLength(30);
    expect(partitions[1].operations).toHaveLength(30);
    expect(partitions[2].operations).toHaveLength(30);
    expect(partitions[3].operations).toHaveLength(30);

    const { sharedSchemas } = resolveSharedSchemas(partitions, stressDoc.components?.schemas ?? {});
    // With 5 shared schemas spread across 120 operations, all 5 must be identified as shared
    expect(sharedSchemas.size).toBe(5);
    for (let s = 0; s < 5; s++) {
      expect(sharedSchemas.has(`SharedMeta_${s}`)).toBe(true);
    }
  });

  it('fails the overall run immediately and identifies the failed unit when a partition fails', async () => {
    const stressDoc = createStressSpec(50, 3);

    let thrownError: PartitionedGenerationError | undefined;
    try {
      await generatePartitioned(stressDoc, {
        partitionSize: 10,
        faultyPartitionId: 'part-2',
      });
    } catch (err) {
      if (err instanceof PartitionedGenerationError) {
        thrownError = err;
      }
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.failedPartitionId).toBe('part-2');
    expect(thrownError?.partitionName).toContain('Chunk partition 2');
    expect(thrownError?.causeError.message).toContain('Simulated partition failure in "part-2"');
    expect(thrownError?.message).toContain('Partitioned generation failed on partition "part-2"');
  });

  it('stress fixture: demonstrates 100% byte-for-byte output parity between partitioned and serial generation', async () => {
    const stressDoc = createStressSpec(150, 6);

    const serialFiles = generateAll(stressDoc);
    const partitionedFiles = await generatePartitioned(stressDoc, {
      partitionSize: 25,
      concurrency: 4,
    });

    expect(partitionedFiles.length).toBe(serialFiles.length);

    for (let i = 0; i < serialFiles.length; i++) {
      expect(partitionedFiles[i].path).toBe(serialFiles[i].path);
      expect(partitionedFiles[i].content).toBe(serialFiles[i].content);
    }
  });

  it('demonstrates output parity on the live explorer OpenAPI specification', async () => {
    const doc = swaggerSpec as OpenApiDocument;
    const serialFiles = generateAll(doc);
    const partitionedFiles = await generatePartitioned(doc, {
      partitionSize: 50,
      concurrency: 4,
    });

    expect(partitionedFiles.length).toBe(serialFiles.length);

    for (let i = 0; i < serialFiles.length; i++) {
      expect(partitionedFiles[i].path).toBe(serialFiles[i].path);
      expect(partitionedFiles[i].content).toBe(serialFiles[i].content);
    }
  });

  it('stress fixture: demonstrates bounded memory consumption during large contract generation', async () => {
    // Generate a 400-operation spec
    const largeDoc = createStressSpec(400, 10);

    // Force garbage collection if exposed, or sample heap baseline
    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const files = await generatePartitioned(largeDoc, {
      partitionSize: 50,
      concurrency: 2,
    });

    const heapAfter = process.memoryUsage().heapUsed;
    const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);

    expect(files.length).toBeGreaterThanOrEqual(8);
    // Bounded heap growth check: partitioned generation should complete within reasonable memory
    expect(heapDeltaMb).toBeLessThan(120); // Well under CI process heap limits (1-2GB)
  });
});
