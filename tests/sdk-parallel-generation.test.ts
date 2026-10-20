import { describe, it, expect } from 'vitest';
import {
  BoundedWorkerPool,
  ParallelGenerationError,
  generateAllParallel,
  buildGenerationTasks,
} from '../scripts/sdk/parallel-generator';
import { generateAll } from '../scripts/sdk/generate';
import { swaggerSpec } from '../src/indexer/swaggerSpec';
import { normalizeOperations, type OpenApiDocument } from '../src/lib/openapi/normalize';

const sampleDoc: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/ping': {
      get: {
        operationId: 'getPing',
        responses: {
          '200': {
            description: 'Pong',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/users': {
      post: {
        operationId: 'createUser',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { username: { type: 'string' } },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: { id: { type: 'string' }, username: { type: 'string' } },
      },
    },
  },
};

describe('BoundedWorkerPool (Issue #1291)', () => {
  it('enforces concurrency bounds and preserves task execution ordering', async () => {
    const pool = new BoundedWorkerPool(3);
    expect(pool.workerCount).toBe(3);

    let activeWorkers = 0;
    let maxObservedWorkers = 0;

    const taskCount = 10;
    const tasks = Array.from({ length: taskCount }, (_, i) => ({
      id: `task-${i}`,
      targetPath: `output/file-${i}.ts`,
      index: i,
    }));

    const results = await pool.runTasks(tasks, async (t) => {
      activeWorkers++;
      maxObservedWorkers = Math.max(maxObservedWorkers, activeWorkers);
      // Small delay to simulate work
      await new Promise((r) => setTimeout(r, 10));
      activeWorkers--;
      return `result-${t.index}`;
    });

    expect(maxObservedWorkers).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(taskCount);
    for (let i = 0; i < taskCount; i++) {
      expect(results[i]).toBe(`result-${i}`);
    }
  });

  it('fails immediately when a worker throws, reports the affected output, and prevents partial success', async () => {
    const pool = new BoundedWorkerPool(2);
    const tasks = [
      { id: 't0', targetPath: 'gen/file0.ts' },
      { id: 't1', targetPath: 'gen/broken.ts' },
      { id: 't2', targetPath: 'gen/file2.ts' },
    ];

    let thrownError: ParallelGenerationError | undefined;
    try {
      await pool.runTasks(tasks, async (t) => {
        if (t.id === 't1') {
          throw new Error('Disk full or syntax failure');
        }
        return `ok-${t.id}`;
      });
    } catch (err) {
      if (err instanceof ParallelGenerationError) {
        thrownError = err;
      }
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.failedTask.id).toBe('t1');
    expect(thrownError?.failedTask.targetPath).toBe('gen/broken.ts');
    expect(thrownError?.failedTask.error.message).toContain('Disk full or syntax failure');
    expect(thrownError?.message).toContain('Parallel SDK generation worker failed on "gen/broken.ts"');
  });
});

describe('Parallel SDK Generation Output Parity (Issue #1291)', () => {
  it('produces identical output ordering and file contents compared to serial generation on mock spec', async () => {
    const serialFiles = generateAll(sampleDoc);
    const parallelFiles = await generateAllParallel(sampleDoc, { maxWorkers: 4 });

    expect(parallelFiles.length).toBe(serialFiles.length);

    for (let i = 0; i < serialFiles.length; i++) {
      expect(parallelFiles[i].path).toBe(serialFiles[i].path);
      expect(parallelFiles[i].content).toBe(serialFiles[i].content);
    }
  });

  it('produces 100% byte-for-byte parity against the live OpenAPI spec across varying worker counts', async () => {
    const serialFiles = generateAll(swaggerSpec as OpenApiDocument);
    const parallelFiles2 = await generateAllParallel(swaggerSpec as OpenApiDocument, { maxWorkers: 2 });
    const parallelFiles4 = await generateAllParallel(swaggerSpec as OpenApiDocument, { maxWorkers: 4 });

    expect(parallelFiles2.length).toBe(serialFiles.length);
    expect(parallelFiles4.length).toBe(serialFiles.length);

    for (let i = 0; i < serialFiles.length; i++) {
      expect(parallelFiles2[i].path).toBe(serialFiles[i].path);
      expect(parallelFiles2[i].content).toBe(serialFiles[i].content);

      expect(parallelFiles4[i].path).toBe(serialFiles[i].path);
      expect(parallelFiles4[i].content).toBe(serialFiles[i].content);
    }
  });

  it('correctly tracks task construction for all independent outputs', () => {
    const ops = normalizeOperations(sampleDoc);
    const tasks = buildGenerationTasks(sampleDoc, ops, 'test-fingerprint', '{}');

    const expectedPaths = [
      'packages/client/src/generated/models.ts',
      'packages/client/src/generated/operations.ts',
      'packages/client/api-surface.json',
    ];

    for (const exp of expectedPaths) {
      expect(tasks.some((t) => t.targetPath === exp)).toBe(true);
    }
    expect(tasks.length).toBeGreaterThanOrEqual(expectedPaths.length);
  });
});
