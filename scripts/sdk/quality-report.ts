/**
 * OpenAPI Quality Report Generator (Issue #1294).
 *
 * Analyzes OpenAPI documents for contract gaps that degrade generated SDKs:
 * - Missing operationId
 * - Undocumented error responses
 * - Incomplete / dangling schemas
 * - Ambiguous pagination metadata
 *
 * Supports baseline mode for gradual adoption and CI gate enforcement.
 */

import fs from 'fs';
import path from 'path';
import { type OpenApiDocument, type JsonSchema } from '../../src/lib/openapi/normalize';
import { logger } from './sdk-logger';

const ROOT = path.join(__dirname, '..', '..');
export const DEFAULT_BASELINE_PATH = path.join(__dirname, 'quality-baseline.json');
export const DEFAULT_REPORT_PATH = path.join(ROOT, 'docs', 'sdk', 'openapi-quality-report.json');

export type FindingSeverity = 'critical' | 'warning' | 'info';
export type FindingCategory =
  | 'missing_operation_id'
  | 'undocumented_error'
  | 'incomplete_schema'
  | 'ambiguous_pagination';

export interface QualityFinding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  pointer: string; // RFC 6901 JSON pointer
  message: string;
  remediation: string;
}

export interface QualityReportSummary {
  critical: number;
  warning: number;
  info: number;
}

export interface QualityReport {
  timestamp: string;
  specVersion: string;
  operationCount: number;
  score: number; // 0 to 100
  summary: QualityReportSummary;
  findings: QualityFinding[];
}

export interface QualityBaseline {
  version: string;
  updatedAt: string;
  knownFingerprints: string[];
}

export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function findingFingerprint(finding: QualityFinding): string {
  return `${finding.category}:${finding.pointer}`;
}

export function analyzeOpenApiQuality(doc: OpenApiDocument): QualityReport {
  const findings: QualityFinding[] = [];
  const paths = doc.paths ?? {};
  const schemas = doc.components?.schemas ?? {};
  const knownSchemas = new Set(Object.keys(schemas));
  let operationCount = 0;

  const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

  // 1. Analyze Schemas under components.schemas
  for (const [schemaName, schemaObj] of Object.entries(schemas)) {
    const schemaPointer = `/components/schemas/${escapePointerSegment(schemaName)}`;
    inspectSchema(schemaObj, schemaPointer, knownSchemas, findings);
  }

  // 2. Analyze Paths and Operations
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of httpMethods) {
      const op = (pathItem as Record<string, any>)[method];
      if (!op || typeof op !== 'object') continue;

      operationCount++;
      const opPointer = `/paths/${escapePointerSegment(pathKey)}/${method}`;

      // Check A: Missing Operation ID
      if (!op.operationId || typeof op.operationId !== 'string' || op.operationId.trim() === '') {
        findings.push({
          id: `Q_OP_ID_${method.toUpperCase()}_${escapePointerSegment(pathKey)}`,
          severity: 'critical',
          category: 'missing_operation_id',
          pointer: `${opPointer}/operationId`,
          message: `Operation ${method.toUpperCase()} ${pathKey} is missing an explicit operationId.`,
          remediation:
            'Specify a unique, deterministic operationId (e.g. "getTransactions") to ensure typed, ergonomic client method names.',
        });
      }

      // Check B: Undocumented Error Responses
      const responses = op.responses ?? {};
      const responseKeys = Object.keys(responses);
      const hasErrorResponse = responseKeys.some((status) => {
        if (status === 'default') return true;
        const code = parseInt(status, 10);
        return !isNaN(code) && code >= 400;
      });

      if (!hasErrorResponse) {
        findings.push({
          id: `Q_ERR_RESP_${method.toUpperCase()}_${escapePointerSegment(pathKey)}`,
          severity: 'warning',
          category: 'undocumented_error',
          pointer: `${opPointer}/responses`,
          message: `Operation ${method.toUpperCase()} ${pathKey} documents no 4xx, 5xx, or default error responses.`,
          remediation:
            'Document at least one standard error response (e.g. 400, 404, 500, or default) with a schema to allow client exception hierarchies.',
        });
      }

      // Check C: Ambiguous Pagination Metadata
      const params = Array.isArray(op.parameters) ? op.parameters : [];
      const hasPaginationParam = params.some(
        (p: any) =>
          p &&
          p.in === 'query' &&
          (p.name === 'cursor' || p.name === 'limit' || p.name === 'offset' || p.name === 'page'),
      );

      if (hasPaginationParam) {
        // Inspect limit param bounds
        const limitParamIndex = params.findIndex((p: any) => p && p.in === 'query' && p.name === 'limit');
        if (limitParamIndex !== -1) {
          const limitParam = params[limitParamIndex];
          const paramSchema = limitParam.schema ?? {};
          if (paramSchema.type && paramSchema.type !== 'integer') {
            findings.push({
              id: `Q_PAG_LIMIT_TYPE_${method.toUpperCase()}_${escapePointerSegment(pathKey)}`,
              severity: 'warning',
              category: 'ambiguous_pagination',
              pointer: `${opPointer}/parameters/${limitParamIndex}/schema/type`,
              message: `Query parameter 'limit' should be type: integer, found ${paramSchema.type}.`,
              remediation: 'Set schema type to integer with minimum and maximum bounds.',
            });
          }
        }

        // Check if 200/201 response defines pagination cursor/hasMore fields
        const successResp = responses['200'] ?? responses['201'];
        const contentSchema =
          successResp?.content?.['application/json']?.schema ?? successResp?.schema;

        if (contentSchema) {
          let resolved = contentSchema;
          if (resolved.$ref) {
            const m = /^#\/components\/schemas\/(.+)$/.exec(resolved.$ref);
            if (m && schemas[m[1]]) {
              resolved = schemas[m[1]];
            }
          }

          if (resolved.type === 'object' && resolved.properties) {
            const propKeys = Object.keys(resolved.properties);
            const hasPaginationField = propKeys.some((k) =>
              ['cursor', 'nextcursor', 'next_cursor', 'hasmore', 'has_more', 'total'].includes(
                k.toLowerCase(),
              ),
            );
            if (!hasPaginationField) {
              findings.push({
                id: `Q_PAG_MISSING_CURSOR_${method.toUpperCase()}_${escapePointerSegment(pathKey)}`,
                severity: 'warning',
                category: 'ambiguous_pagination',
                pointer: `${opPointer}/responses/200/content/application~1json/schema`,
                message: `Operation accepts pagination parameters but response schema defines no pagination cursor or token field.`,
                remediation:
                  'Include pagination metadata fields (such as nextCursor or hasMore) in the response schema to support client auto-pagination.',
              });
            }
          }
        }
      }
    }
  }

  // Calculate scores
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warning = findings.filter((f) => f.severity === 'warning').length;
  const info = findings.filter((f) => f.severity === 'info').length;

  // Deduct 10 points per critical and 1 point per warning, bounded to 0-100
  const score = Math.max(0, Math.min(100, Math.round(100 - (critical * 10 + warning * 1))));

  return {
    timestamp: new Date().toISOString(),
    specVersion: doc.info?.version ?? '0.0.0',
    operationCount,
    score,
    summary: { critical, warning, info },
    findings,
  };
}

function inspectSchema(
  schema: JsonSchema | null | undefined,
  pointer: string,
  knownSchemas: Set<string>,
  findings: QualityFinding[],
  depth = 0,
): void {
  if (!schema || depth > 5) return;

  // Check Dangling $ref
  if (typeof schema.$ref === 'string') {
    const m = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
    if (m && !knownSchemas.has(m[1])) {
      findings.push({
        id: `Q_DANGLING_REF_${escapePointerSegment(m[1])}`,
        severity: 'critical',
        category: 'incomplete_schema',
        pointer: `${pointer}/$ref`,
        message: `Dangling $ref reference: schema '${m[1]}' does not exist in components.schemas.`,
        remediation: `Declare schema '${m[1]}' under components.schemas or fix the reference pointer.`,
      });
    }
    return;
  }

  // Check array without items
  if (schema.type === 'array' && !schema.items) {
    findings.push({
      id: `Q_ARRAY_NO_ITEMS_${escapePointerSegment(pointer)}`,
      severity: 'critical',
      category: 'incomplete_schema',
      pointer: `${pointer}/items`,
      message: `Array schema is missing 'items' element type definition.`,
      remediation: `Add an 'items' specification defining the item schema for this array.`,
    });
  }

  // Recursively inspect properties
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      inspectSchema(
        propSchema,
        `${pointer}/properties/${escapePointerSegment(propName)}`,
        knownSchemas,
        findings,
        depth + 1,
      );
    }
  }

  // Inspect items
  if (schema.items) {
    inspectSchema(schema.items, `${pointer}/items`, knownSchemas, findings, depth + 1);
  }
}

export function compareWithBaseline(
  report: QualityReport,
  baseline: QualityBaseline,
): { newCriticalFindings: QualityFinding[]; newFindings: QualityFinding[]; passes: boolean } {
  const known = new Set(baseline.knownFingerprints);
  const newFindings = report.findings.filter((f) => !known.has(findingFingerprint(f)));
  const newCriticalFindings = newFindings.filter((f) => f.severity === 'critical');

  return {
    newCriticalFindings,
    newFindings,
    passes: newCriticalFindings.length === 0,
  };
}

export function saveBaseline(report: QualityReport, baselinePath = DEFAULT_BASELINE_PATH): void {
  const baseline: QualityBaseline = {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    knownFingerprints: Array.from(new Set(report.findings.map(findingFingerprint))).sort(),
  };
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
}

export async function runQualityReportCLI(): Promise<void> {
  const checkMode = process.argv.includes('--check');
  const updateBaseline = process.argv.includes('--update-baseline');
  const baselineArgIdx = process.argv.indexOf('--baseline');
  const baselinePath = baselineArgIdx !== -1 ? process.argv[baselineArgIdx + 1] : DEFAULT_BASELINE_PATH;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { swaggerSpec } = require('../../src/indexer/swaggerSpec') as {
    swaggerSpec: OpenApiDocument;
  };

  const report = analyzeOpenApiQuality(swaggerSpec);

  // Write report artifact when generating/updating, not during read-only CI checks
  if (!checkMode) {
    fs.mkdirSync(path.dirname(DEFAULT_REPORT_PATH), { recursive: true });
    fs.writeFileSync(DEFAULT_REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`Report written to: ${path.relative(ROOT, DEFAULT_REPORT_PATH)}`);
  }

  console.log(`OpenAPI Quality Report (Score: ${report.score}/100)`);
  console.log(`Operations analyzed: ${report.operationCount}`);
  console.log(
    `Findings: ${report.summary.critical} critical, ${report.summary.warning} warnings, ${report.summary.info} info`,
  );

  if (updateBaseline) {
    saveBaseline(report, baselinePath);
    console.log(`Quality baseline updated at: ${path.relative(ROOT, baselinePath)}`);
    return;
  }

  if (checkMode) {
    if (!fs.existsSync(baselinePath)) {
      console.warn(`Baseline file not found at ${baselinePath}. Writing initial baseline.`);
      saveBaseline(report, baselinePath);
      return;
    }

    const baselineData: QualityBaseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const { newCriticalFindings, newFindings, passes } = compareWithBaseline(report, baselineData);

    if (!passes) {
      console.error(`\n❌ CI Check Failed: ${newCriticalFindings.length} newly introduced critical quality findings detected!`);
      for (const f of newCriticalFindings) {
        console.error(`  - [${f.category}] ${f.pointer}`);
        console.error(`    Message: ${f.message}`);
        console.error(`    Remediation: ${f.remediation}\n`);
      }
      process.exit(1);
    }

    console.log(`\n✅ Quality baseline check passed. (${newFindings.length} new non-critical findings)`);
  }
}

if (require.main === module) {
  runQualityReportCLI().catch((err) => {
    console.error('Error generating OpenAPI quality report:', err);
    process.exit(1);
  });
}
