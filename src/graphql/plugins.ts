import { Plugin } from 'graphql-yoga';
import depthLimit from 'graphql-depth-limit';
import { getOperationAST, GraphQLError } from 'graphql';
import { graphqlOperationDuration, graphqlOperationErrorsTotal } from './metrics';

const DEFAULT_MAX_COMPLEXITY = 1000;
const DEFAULT_MAX_DEPTH = 5;

/** Read env limits at execution time so tests/tuning can override per-process. */
function maxComplexity(): number {
  const parsed = parseInt(process.env.GQL_MAX_COMPLEXITY ?? '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_MAX_COMPLEXITY;
}

function maxDepth(): number {
  const parsed = parseInt(process.env.GQL_MAX_DEPTH ?? '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_MAX_DEPTH;
}

export const complexityPlugin: Plugin = {
  onExecute({ args }) {
    const limit = maxComplexity();
    const complexity = calculateComplexity(args.document);
    if (complexity > limit) {
      throw new GraphQLError(`Query too complex: ${complexity} exceeds limit of ${limit}`);
    }
  },
};

export const depthLimitPlugin: Plugin = {
  onExecute({ args }) {
    const limit = maxDepth();
    const rule = depthLimit(limit) as unknown as { visitor?: unknown };
    const errors = rule(null, args.document);
    if (errors && errors.length > 0) {
      throw new GraphQLError(`Query exceeds maximum depth of ${limit}`);
    }
  },
};

export const graphqlMetricsPlugin: Plugin = {
  onExecute({ args }) {
    const operationType =
      getOperationAST(args.document, args.operationName)?.operation ?? 'unknown';
    const startTime = process.hrtime.bigint();

    return {
      onExecuteDone({ result }) {
        const failed =
          !isAsyncIterable(result) &&
          typeof result === 'object' &&
          result !== null &&
          'errors' in result &&
          Array.isArray(result.errors) &&
          result.errors.length > 0;
        graphqlOperationDuration.observe(
          { operation_type: operationType, status: failed ? 'error' : 'success' },
          Number(process.hrtime.bigint() - startTime) / 1e9,
        );
        if (failed) graphqlOperationErrorsTotal.inc({ operation_type: operationType });
      },
    };
  },
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function calculateComplexity(doc: any): number {
  if (!doc?.definitions) return 0;
  const fragments: Record<string, any> = {};
  for (const def of doc.definitions) {
    if (def.kind === 'FragmentDefinition') {
      fragments[def.name.value] = def;
    }
  }
  let total = 0;
  for (const def of doc.definitions) {
    if (def.kind === 'OperationDefinition') {
      total += visitNode(def.selectionSet, 1, fragments, new Set());
    }
  }
  return total;
}

function getListMultiplier(sel: any): number {
  if (!sel.arguments?.length) return 1;
  const limitArg = sel.arguments.find(
    (a: any) => a.name.value === 'limit' || a.name.value === 'first',
  );
  if (!limitArg) return 1;
  if (limitArg.value.kind === 'IntValue') return Math.max(1, parseInt(limitArg.value.value, 10));
  return 1;
}

function visitNode(
  selectionSet: any,
  depth: number,
  fragments: Record<string, any>,
  inPath: Set<string>,
): number {
  if (!selectionSet?.selections) return 0;
  let cost = 0;
  for (const sel of selectionSet.selections) {
    if (sel.kind === 'Field') {
      const multiplier = getListMultiplier(sel);
      cost += depth * multiplier;
      if (sel.selectionSet) {
        cost += visitNode(sel.selectionSet, depth + 1, fragments, inPath);
      }
    } else if (sel.kind === 'InlineFragment') {
      if (sel.selectionSet) {
        cost += visitNode(sel.selectionSet, depth, fragments, inPath);
      }
    } else if (sel.kind === 'FragmentSpread') {
      const fragName = sel.name.value;
      if (!inPath.has(fragName)) {
        const fragment = fragments[fragName];
        if (fragment?.selectionSet) {
          inPath.add(fragName);
          cost += visitNode(fragment.selectionSet, depth, fragments, inPath);
          inPath.delete(fragName);
        }
      }
    }
  }
  return cost;
}
