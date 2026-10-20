/**
 * Schema compatibility between Kafka events and the Parquet output (#1247).
 *
 * Two seams can drift independently:
 *   1. Event schemas in the lakehouse schema registry (`CORE_SCHEMAS`) vs the
 *      analytics Parquet schema (`ANALYTICS_PARQUET_SCHEMA`) — checked with
 *      `checkEventToParquetCompatibility`.
 *   2. Records produced by the CDC transform (`transformRecord`) vs the Parquet
 *      schema they are written with — checked row-by-row with `validateParquetRow`.
 */

import { ANALYTICS_PARQUET_SCHEMA } from '../data-lake/iceberg-writer';
import type { FieldType, SchemaField } from '../lakehouse/schema-registry';

export type ParquetType = 'UTF8' | 'INT32' | 'INT64' | 'DOUBLE' | 'BOOLEAN';

export interface ParquetField {
  name: string;
  type: string;
  optional?: boolean;
}

/**
 * Parquet column types each event field type can be written to without loss.
 * Numeric values may be stored as UTF8 decimal strings (fees and amounts are
 * kept as strings in Parquet to preserve i128 precision downstream).
 */
export const LOSSLESS_PARQUET_TYPES: Record<FieldType, ParquetType[]> = {
  string: ['UTF8'],
  bytes: ['UTF8'],
  int: ['INT32', 'INT64', 'UTF8'],
  long: ['INT64', 'UTF8'],
  double: ['DOUBLE', 'UTF8'],
  boolean: ['BOOLEAN'],
};

/** Event fields whose Parquet column has a different name. */
export const EVENT_TO_PARQUET_FIELD_MAP: Record<string, Record<string, string>> = {
  'soroban.swap.executed': { amount_in: 'swap_amount_in', amount_out: 'swap_amount_out' },
};

export interface EventToParquetReport {
  subject: string;
  compatible: boolean;
  violations: string[];
  /** Event fields with no Parquet column — not persisted to the lake. */
  droppedFields: string[];
}

export function checkEventToParquetCompatibility(
  subject: string,
  fields: SchemaField[],
  parquetFields: ParquetField[] = ANALYTICS_PARQUET_SCHEMA.fields,
  fieldMap: Record<string, string> = EVENT_TO_PARQUET_FIELD_MAP[subject] ?? {},
): EventToParquetReport {
  const columns = new Map(parquetFields.map((f) => [f.name, f]));
  const violations: string[] = [];
  const droppedFields: string[] = [];

  for (const field of fields) {
    const columnName = fieldMap[field.name] ?? field.name;
    const column = columns.get(columnName);
    if (!column) {
      droppedFields.push(field.name);
      continue;
    }
    const allowed = LOSSLESS_PARQUET_TYPES[field.type] ?? [];
    if (!allowed.includes(column.type as ParquetType)) {
      violations.push(`"${field.name}" (${field.type}) cannot be written losslessly to ${column.type} column "${columnName}"`);
    }
    if (field.optional && field.default == null && !column.optional) {
      violations.push(`optional event field "${field.name}" maps to required column "${columnName}"`);
    }
  }

  return { subject, compatible: violations.length === 0, violations, droppedFields };
}

function matchesParquetType(type: string, value: unknown): boolean {
  switch (type) {
    case 'UTF8':
      return typeof value === 'string';
    case 'INT32':
    case 'INT64':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'DOUBLE':
      return typeof value === 'number' && Number.isFinite(value);
    case 'BOOLEAN':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/** Violations that would make `row` unreadable (or silently lossy) under `parquetFields`. */
export function validateParquetRow(
  row: Record<string, unknown>,
  parquetFields: ParquetField[] = ANALYTICS_PARQUET_SCHEMA.fields,
): string[] {
  const violations: string[] = [];
  const known = new Set(parquetFields.map((f) => f.name));

  for (const field of parquetFields) {
    const value = row[field.name];
    if (value === null || value === undefined) {
      if (!field.optional) violations.push(`required column "${field.name}" is ${value === null ? 'null' : 'missing'}`);
      continue;
    }
    if (!matchesParquetType(field.type, value)) {
      violations.push(`column "${field.name}" expected ${field.type}, got ${JSON.stringify(value)}`);
    }
  }
  for (const key of Object.keys(row)) {
    if (!known.has(key)) violations.push(`column "${key}" is not in the Parquet schema`);
  }
  return violations;
}
