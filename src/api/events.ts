import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { conditionalCache } from '../middleware/conditionalCache';
import { validateQuery, validateParams } from '../middleware/validation';
import { sendValidatedResponse } from '../middleware/responseValidation';
import { paginationSchema, stellarAddress, safeLabel } from '../schemas/common';
import {
  eventListResponseSchema,
  eventResponseSchema,
} from '../schemas/transaction-event-responses';
import { eventService } from '../services/event.service';
import { createCursorScope, decodeOpaqueCursor, encodeOpaqueCursor } from '../utils/opaque-cursor';

/**
 * @swagger
 * tags:
 *   name: Events
 *   description: Decoded Soroban contract events
 */

export const eventRouter = Router();

// Enhanced schema with filters from common schemas
const eventListQuerySchema = paginationSchema
  .merge(
    z.object({
      contract: stellarAddress.optional(),
      type: safeLabel.optional(),
      topic: safeLabel.optional(),
      // #914 — cursor-based pagination (preferred for deep pages); page/limit
      // remains supported as a compatibility shim.
      cursor: z.string().max(2048).optional(),
      pagination: z.literal('cursor').optional(),
    }),
  )
  .superRefine((query, context) => {
    if (query.pagination === 'cursor' && query.page !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['page'],
        message: 'page cannot be used with cursor pagination',
      });
    }
  });

/**
 * @swagger
 * /events:
 *   get:
 *     summary: List decoded contract events
 *     tags: [Events]
 *     parameters:
 *       - in: query
 *         name: contract
 *         schema: { type: string }
 *         description: Filter by contract address (exact match)
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *         description: Filter by event type (e.g. transfer, swap, mint, burn, custom)
 *       - in: query
 *         name: topic
 *         schema: { type: string }
 *         description: Filter by decoded first-topic symbol (e.g. "transfer", "mint_pass")
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: 1-based page number for legacy offset pagination; do not combine with pagination=cursor
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *         description: Page size
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: Legacy event-id cursor, or the opaque nextCursor value when `pagination=cursor`.
 *       - in: query
 *         name: pagination
 *         schema: { type: string, enum: [cursor] }
 *         description: Select the stable opaque cursor contract. On the first page, omit `cursor`; pass the returned `nextCursor` on subsequent requests.
 *     responses:
 *       200:
 *         description: Stable cursor requests return { data, nextCursor, hasNext }; legacy cursor and offset requests retain their existing response shape.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               oneOf:
 *                 - title: StableCursorPage
 *                   type: object
 *                   required: [data, nextCursor, hasNext]
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         description: Event summary
 *                         properties:
 *                           id: { type: string }
 *                           transactionHash: { type: string }
 *                           contractAddress: { type: string }
 *                           eventType: { type: string }
 *                           topicSymbol: { type: string, nullable: true }
 *                           decoded: { type: object, nullable: true }
 *                           ledgerSequence: { type: integer }
 *                           ledgerCloseTime: { type: string, format: date-time }
 *                     nextCursor: { type: string, nullable: true, description: 'Opaque cursor; pass with pagination=cursor' }
 *                     hasNext: { type: boolean }
 *                 - title: LegacyPage
 *                   type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         description: Event summary
 *                         properties:
 *                           id: { type: string }
 *                           transactionHash: { type: string }
 *                           contractAddress: { type: string }
 *                           eventType: { type: string }
 *                           topicSymbol: { type: string, nullable: true }
 *                           decoded: { type: object, nullable: true }
 *                           ledgerSequence: { type: integer }
 *                           ledgerCloseTime: { type: string, format: date-time }
 *                     total: { type: integer, description: 'Total number of events matching the filter' }
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     nextCursor: { type: string, nullable: true, description: 'Legacy event-id cursor' }
 *               example:
 *                 data:
 *                   - id: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAAh0cmFuc2Zlcg=='
 *                     transactionHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     eventType: transfer
 *                     topicSymbol: transfer
 *                     decoded: { from: 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI', amount: '1000000000' }
 *                     ledgerSequence: 3168075
 *                     ledgerCloseTime: '2026-06-19T07:24:26.000Z'
 *                   - id: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566-AAAADwAAAARzd2Fw'
 *                     transactionHash: '3389e9f0f1a4e32477b1c0d9e8a6f5b4c3d2e1f0a9b8c7d6e5f40312233445566'
 *                     contractAddress: CALLD5GHXR4QSTKHSWQEK4UVMHM4QHU4KZ5G4SBKWY7C7TXKZ45RJ4M5
 *                     eventType: swap
 *                     topicSymbol: swap
 *                     decoded: { amount_in: '1000000000', amount_out: '987000000' }
 *                     ledgerSequence: 3168074
 *                     ledgerCloseTime: '2026-06-19T07:23:20.000Z'
 *                 total: 1543
 *                 page: 1
 *                 limit: 20
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: limit must be less than or equal to 100
 */
// GET /events?contract=&type=&topic=&page=1
eventRouter.get(
  '/',
  validateQuery(eventListQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const query = req.validatedQuery as z.infer<typeof eventListQuerySchema>;
    const result = await eventService.listEvents(query);
    res.json(result);
  }),
);

/**
 * @swagger
 * /events/{id}:
 *   get:
 *     summary: Get a single event by ID
 *     tags: [Events]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Unique event identifier
 *     responses:
 *       200:
 *         description: The full event record
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Event'
 *       404:
 *         description: Event not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/Error'
 *               example:
 *                 error: Event not found
 */
// GET /events/:id
eventRouter.get(
  '/:id',
  validateParams(z.object({ id: z.string() })),
  conditionalCache,
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.validatedParams as { id: string };
    const event = await eventService.getEventById(params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    sendValidatedResponse(res, eventResponseSchema, event, 'GET /events/:id');
  }),
);
