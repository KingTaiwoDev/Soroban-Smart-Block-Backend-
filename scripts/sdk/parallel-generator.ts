/**
 * Parallel SDK File Generator (Issue #1291).
 *
 * Parallelizes independent output work across a bounded worker pool while
 * preserving deterministic artifact ordering and file content parity with
 * serial generation.
 *
 * Ensures that if any worker task fails, the error details and affected output
 * path are surfaced immediately, preventing partial success from being treated
 * as complete.
 */
import os from 'os';
import { createHash } from 'crypto';
import type { OpenApiDocument, NormalizedOperation } from '../../src/lib/openapi/normalize';
import { normalizeOperations } from '../../src/lib/openapi/normalize';
import { emitModels, emitOperations } from './emit-typescript';
import { buildSurface } from './surface';
import { emitParityMatrix } from './parity';
import { EXTRA_EMITTERS } from './emitters';
import type { GeneratedFile } from './generate';
import { logger } from './sdk-logger';

export interface ParallelOptions {
  /** Maximum number of concurrent generation tasks (default: min(cpus, 4)). */
  maxWorkers?: number;
  /** Custom correlation ID for tracing. */
  correlationId?: string;
}

export interface GenerationTask {
  id: string;
  targetPath: string;
  order: number;
  execute: () => Promise<GeneratedFile | GeneratedFile[]> | GeneratedFile | GeneratedFile[];
}

export class ParallelGenerationError extends Error {
  constructor(
    message: string,
    public readonly failedTask: { id: string; targetPath: string; error: Error },
    public readonly allErrors: Array<{ id: string; targetPath: string; error: Error }>,
  ) {
    super(message);
    this.name = 'ParallelGenerationError';
  }
}

/**
 * Bounded worker pool for executing independent asynchronous tasks.
 */
export class BoundedWorkerPool {
  private readonly concurrency: number;

  constructor(concurrency?: number) {
    const defaultWorkers = Math.max(1, Math.min(os.cpus().length || 1, 4));
    this.concurrency = concurrency && concurrency > 0 ? concurrency : defaultWorkers;
  }

  get workerCount(): number {
    return this.concurrency;
  }

  async runTasks<TTask extends { id: string; targetPath: string }, TResult>(
    tasks: TTask[],
    executor: (task: TTask) => Promise<TResult>,
  ): Promise<TResult[]> {
    const results: TResult[] = new Array(tasks.length);
    const errors: Array<{ id: string; targetPath: string; error: Error }> = [];
    let nextIndex = 0;
    let hasFailed = false;

    const worker = async () => {
      while (nextIndex < tasks.length && !hasFailed) {
        const index = nextIndex++;
        const task = tasks[index];
        try {
          const res = await executor(task);
          results[index] = res;
        } catch (err) {
          hasFailed = true;
          const errorObj = err instanceof Error ? err : new Error(String(err));
          errors.push({ id: task.id, targetPath: task.targetPath, error: errorObj });
        }
      }
    };

    const workerPromises: Promise<void>[] = [];
    const actualWorkers = Math.min(this.concurrency, tasks.length);
    for (let i = 0; i < actualWorkers; i++) {
      workerPromises.push(worker());
    }

    await Promise.all(workerPromises);

    if (errors.length > 0) {
      const primary = errors[0];
      throw new ParallelGenerationError(
        `Parallel SDK generation worker failed on "${primary.targetPath}" (${primary.id}): ${primary.error.message}`,
        primary,
        errors,
      );
    }

    return results;
  }
}

/**
 * Build independent generation tasks for an OpenAPI specification.
 */
export function buildGenerationTasks(
  doc: OpenApiDocument,
  ops: NormalizedOperation[],
  fingerprint: string,
  surfaceJson: string,
): GenerationTask[] {
  let orderCounter = 0;
  const tasks: GenerationTask[] = [];

  // Task 1: TypeScript Models
  tasks.push({
    id: 'ts-models',
    targetPath: 'packages/client/src/generated/models.ts',
    order: orderCounter++,
    execute: () => ({
      path: 'packages/client/src/generated/models.ts',
      content: emitModels(doc),
    }),
  });

  // Task 2: TypeScript Operations
  tasks.push({
    id: 'ts-operations',
    targetPath: 'packages/client/src/generated/operations.ts',
    order: orderCounter++,
    execute: () => ({
      path: 'packages/client/src/generated/operations.ts',
      content: emitOperations(doc, ops, fingerprint),
    }),
  });

  // Task 3: API Surface Manifest
  tasks.push({
    id: 'ts-surface',
    targetPath: 'packages/client/api-surface.json',
    order: orderCounter++,
    execute: () => ({
      path: 'packages/client/api-surface.json',
      content: surfaceJson,
    }),
  });

  // Tasks for Extra Emitters (Python, C#, etc.)
  for (let emitterIdx = 0; emitterIdx < EXTRA_EMITTERS.length; emitterIdx++) {
    const emitter = EXTRA_EMITTERS[emitterIdx];
    tasks.push({
      id: `emitter-${emitterIdx}`,
      targetPath: `emitter-bundle-${emitterIdx}`,
      order: orderCounter++,
      execute: () => emitter({ doc, ops, fingerprint }),
    });
  }

  return tasks;
}

/**
 * Generate all SDK files concurrently using a bounded worker pool.
 * Output ordering and contents are identical to serial generation.
 */
export async function generateAllParallel(
  doc: OpenApiDocument,
  options?: ParallelOptions,
): Promise<GeneratedFile[]> {
  const ops = normalizeOperations(doc);
  const specVersion = doc.info?.version ?? '0.0.0';
  const surface = buildSurface(specVersion, ops);
  const surfaceJson = `${JSON.stringify(surface, null, 2)}\n`;
  const fingerprint = createHash('sha256').update(surfaceJson).digest('hex').slice(0, 16);

  const pool = new BoundedWorkerPool(options?.maxWorkers);
  const tasks = buildGenerationTasks(doc, ops, fingerprint, surfaceJson);

  logger.debug('Executing parallel SDK generation', {
    taskCount: tasks.length,
    concurrency: pool.workerCount,
    correlationId: options?.correlationId,
  });

  const rawResults = await pool.runTasks(tasks, async (task) => {
    return task.execute();
  });

  // Flatten results while preserving canonical serial order
  const files: GeneratedFile[] = [];
  for (const item of rawResults) {
    if (Array.isArray(item)) {
      files.push(...item);
    } else {
      files.push(item);
    }
  }

  // Parity matrix is generated from the complete file set
  files.push({
    path: 'docs/sdk/parity-matrix.md',
    content: emitParityMatrix(ops, files),
  });

  return files;
}
