/**
 * Transaction Service — encapsulates business logic for transaction retrieval and queries.
 */

import {
  TransactionRepository,
  transactionRepository,
} from '../repositories/transaction.repository';
import { getBn254ExemptionByTx } from '../indexer/bn254-tracker';
import {
  decodeStableCursor,
  encodeStableCursor,
  InvalidCursorError,
  type CursorPage,
} from '../utils/stable-cursor';

export interface TransactionListFilter {
  cursor?: number | string;
  pagination?: 'cursor';
  page?: number;
  limit?: number;
  contract?: string;
  account?: string;
  status?: string;
  ledgerMin?: number;
  ledgerMax?: number;
}

export interface CursorPaginatedTransactions {
  data: any[];
  nextCursor: { ledgerSequence: number; id: string } | null;
  hasNext: boolean;
}

export interface OffsetPaginatedTransactions {
  data: any[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export type StableCursorTransactions = CursorPage<any>;

export class TransactionService {
  constructor(private readonly repo: TransactionRepository = transactionRepository) {}

  buildFilterWhere(q: TransactionListFilter): Record<string, any> {
    const where: Record<string, any> = {
      ...(q.contract && { contractAddress: q.contract }),
      ...(q.account && { sourceAccount: q.account }),
      ...(q.status && { status: q.status }),
      ...((q.ledgerMin !== undefined || q.ledgerMax !== undefined) && {
        ledgerSequence: {
          ...(q.ledgerMin !== undefined && { gte: q.ledgerMin }),
          ...(q.ledgerMax !== undefined && { lte: q.ledgerMax }),
        },
      }),
    };
    return where;
  }

  async listTransactions(
    query: TransactionListFilter,
  ): Promise<CursorPaginatedTransactions | OffsetPaginatedTransactions | StableCursorTransactions> {
    const limit = query.limit ?? 20;
    const where = this.buildFilterWhere(query);

    if (query.pagination === 'cursor') {
      if (query.cursor !== undefined && typeof query.cursor !== 'string') {
        throw new InvalidCursorError();
      }
      const after =
        typeof query.cursor === 'string'
          ? decodeStableCursor(query.cursor, 'transactions')
          : undefined;
      const rows = await this.repo.findMany({
        where,
        take: limit + 1,
        after,
        includeCursorId: true,
      });

      const hasNext = rows.length > limit;
      const pageRows = hasNext ? rows.slice(0, limit) : rows;
      const data = pageRows.map(
        ({ id: _id, ...row }: { id: string; [key: string]: unknown }) => row,
      );
      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor =
        hasNext && lastRow
          ? encodeStableCursor('transactions', {
              ledgerSequence: lastRow.ledgerSequence,
              id: lastRow.id,
            })
          : null;

      return { data, nextCursor, hasNext };
    }

    if (query.cursor !== undefined) {
      const cursor = typeof query.cursor === 'number' ? query.cursor : Number(query.cursor);
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new InvalidCursorError();
      }
      // Cursor-based pagination (descending ledgerSequence)
      where.ledgerSequence = { ...where.ledgerSequence, lt: cursor };

      const rows = await this.repo.findMany({
        where: cursorWhere,
        take: limit + 1,
      });

      const hasNext = rows.length > limit;
      const data = hasNext ? rows.slice(0, limit) : rows;
      const nextCursor = hasNext ? (data[data.length - 1] as Record<string, unknown>).ledgerSequence as number : null;

      return { data, nextCursor, hasNext };
    }

    // Offset-based pagination
    const page = query.page ?? 1;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.repo.findMany({
        where,
        skip,
        take: limit,
      }),
      this.repo.count(where),
    ]);

    return {
      data,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  }

  async getTransactionByHash(hash: string): Promise<any | null> {
    const tx = await this.repo.findByHashWithEvents(hash);
    if (!tx) return null;

    const bn254GasExemption = await getBn254ExemptionByTx(hash).catch((): null => null);
    return {
      ...tx,
      ...(bn254GasExemption ? { bn254GasExemption } : {}),
    };
  }

  async getRawXdrByHash(hash: string): Promise<{ hash: string; rawXdr: string } | null> {
    return this.repo.findRawXdrByHash(hash);
  }
}

export const transactionService = new TransactionService();
