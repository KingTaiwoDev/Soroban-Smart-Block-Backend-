import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { featureFlags } from '../feature-flags';
import { logger } from '../logger';
import { contractAbiSubmissionOperations } from '../metrics';
import { adminAuth } from '../middleware/adminAuth';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireApiKey } from '../middleware/apiKeyAuth';
import { isValidStellarAddress } from '../middleware/sanitize';
import {
  createContractAbiSubmission,
  getContractAbiSubmission,
  listContractAbiSubmissions,
  publishContractAbiSubmission,
  reviewContractAbiSubmission,
} from '../services/contract-abi-submissions';

const stellarAddress = z.string().refine(isValidStellarAddress, {
  message: 'Invalid Stellar contract address',
});

const abiFunctionSchema = z
  .object({
    name: z.string().min(1).max(128).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    inputs: z
      .array(z.object({ name: z.string().min(1).max(128), type: z.string().min(1).max(128) }).strict())
      .max(64),
    outputs: z.array(z.object({ type: z.string().min(1).max(128) }).strict()).max(64).optional(),
    humanTemplate: z.string().max(2048).optional(),
  })
  .strict();

const abiEventSchema = z
  .object({
    name: z.string().min(1).max(128).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    inputs: z
      .array(z.object({ name: z.string().min(1).max(128), type: z.string().min(1).max(128) }).strict())
      .max(64)
      .optional(),
  })
  .strict();

const abiSchema = z
  .object({
    functions: z.array(abiFunctionSchema).max(256).default([]),
    events: z.array(abiEventSchema).max(256).optional(),
  })
  .strict()
  .refine((abi) => abi.functions.length > 0 || (abi.events?.length ?? 0) > 0, {
    message: 'At least one ABI function or event is required',
  })
  .superRefine(({ functions, events }, context) => {
    const functionNames = new Set<string>();
    functions.forEach((fn, index) => {
      if (functionNames.has(fn.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['functions', index, 'name'],
          message: 'Function names must be unique',
        });
      }
      functionNames.add(fn.name);
    });
    const eventNames = new Set<string>();
    events?.forEach((event, index) => {
      if (eventNames.has(event.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index, 'name'],
          message: 'Event names must be unique',
        });
      }
      eventNames.add(event.name);
    });
  });

const trustLevelEnum = z.enum(['unverified', 'community', 'verified_publisher', 'canonical', 'official']);

const provenanceSchema = z
  .object({
    source: z.string().max(128).optional(),
    repoUrl: z.string().max(512).optional(),
    commitHash: z.string().max(64).optional(),
    submitterIdentity: z.string().max(256).optional(),
    attestationUrl: z.string().max(512).optional(),
    signature: z.string().max(1024).optional(),
    signerAddress: z.string().max(128).optional(),
    verifiedAt: z.string().optional(),
    notes: z.string().max(2048).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

const submissionSchema = z
  .object({
    address: stellarAddress,
    network: z.enum(['testnet', 'mainnet', 'devnet']),
    name: z.string().min(1).max(256).optional(),
    description: z.string().max(2048).optional(),
    abi: abiSchema,
    abiVersion: z.string().min(1).max(64).optional(),
    version: z.string().min(1).max(64).optional(),
    wasmHash: z.string().regex(/^[a-fA-F0-9]{1,64}$/).optional(),
    protocolKey: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/).optional(),
    deployedAtLedger: z.number().int().nonnegative().max(2_147_483_647).optional(),
    trustLevel: trustLevelEnum.optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

const reviewSchema = z.object({ reviewNote: z.string().trim().min(1).max(2000) }).strict();
const approveSchema = z
  .object({
    reviewNote: z.string().trim().max(2000).optional(),
    trustLevel: trustLevelEnum.optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();
const listSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'published']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const submissionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }),
});

function isExpectedRejection(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
    (error as { statusCode: number }).statusCode < 500
  );
}

async function featureGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const available = await featureFlags.isAvailable('contractAbiSubmissions');
    if (!available) {
      contractAbiSubmissionOperations.inc({ operation: 'gate', outcome: 'schema_unavailable' });
      res.status(503).json({
        error: 'Contract ABI submissions are unavailable until the database migration is applied',
        code: 'SCHEMA_UNAVAILABLE',
      });
      return;
    }
    const enabled = await featureFlags.isEnabled('contractAbiSubmissions', {
      developerId: req.apiKey?.developerId,
    });
    if (!enabled) {
      contractAbiSubmissionOperations.inc({ operation: 'gate', outcome: 'disabled' });
      res.status(404).json({ error: 'Feature not found', code: 'FEATURE_DISABLED' });
      return;
    }
    next();
  } catch (error) {
    contractAbiSubmissionOperations.inc({ operation: 'gate', outcome: 'error' });
    logger.error('contract ABI submission feature gate failed', { error: String(error) });
    res.status(503).json({ error: 'Feature availability could not be verified', code: 'FEATURE_UNAVAILABLE' });
  }
}

export const contractAbiSubmissionsRouter = Router();
contractAbiSubmissionsRouter.use(submissionRateLimit, requireApiKey, featureGate);

/**
 * @swagger
 * /contracts/abi-submissions:
 *   post:
 *     summary: Submit contract ABI metadata for moderation
 *     tags: [Contracts]
 *     parameters:
 *       - in: header
 *         name: X-Api-Key
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address, network, abi]
 *             properties:
 *               address: { type: string, description: Stellar contract address }
 *               network: { type: string, enum: [testnet, mainnet, devnet] }
 *               name: { type: string, maxLength: 256 }
 *               description: { type: string, maxLength: 2048 }
 *               abi:
 *                 type: object
 *                 required: [functions]
 *                 properties:
 *                   functions:
 *                     type: array
 *                     maxItems: 256
 *                     items:
 *                       type: object
 *                       required: [name, inputs]
 *                       properties:
 *                         name: { type: string, maxLength: 128 }
 *                         inputs:
 *                           type: array
 *                           maxItems: 64
 *                           items:
 *                             type: object
 *                             required: [name, type]
 *                             properties:
 *                               name: { type: string, maxLength: 128 }
 *                               type: { type: string, maxLength: 128 }
 *                         outputs:
 *                           type: array
 *                           maxItems: 64
 *                           items:
 *                             type: object
 *                             required: [type]
 *                             properties:
 *                               type: { type: string, maxLength: 128 }
 *                         humanTemplate: { type: string, maxLength: 2048 }
 *                   events:
 *                     type: array
 *                     maxItems: 256
 *                     description: Optional event definitions checked against indexed topic symbols
 *                     items:
 *                       type: object
 *                       required: [name]
 *                       properties:
 *                         name: { type: string, maxLength: 128 }
 *                         inputs: { type: array, maxItems: 64, items: { type: object } }
 *               abiVersion: { type: string, maxLength: 64 }
 *               version: { type: string, maxLength: 64 }
 *               wasmHash: { type: string, maxLength: 64 }
 *               protocolKey: { type: string, maxLength: 128 }
 *               deployedAtLedger: { type: integer, minimum: 0 }
 *           example:
 *             address: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
 *             network: testnet
 *             abi:
 *               functions: [{ name: transfer, inputs: [{ name: to, type: Address }] }]
 *     responses:
 *       201: { description: New submission recorded as pending }
 *       200: { description: Idempotent replay returned the existing submission }
 *       400: { description: Invalid submission payload }
 *       413: { description: Payload exceeds 64 KiB }
 *       422: { description: Active network mismatch or no indexed ABI evidence }
 *       429: { description: Submission rate limit exceeded }
 *       503: { description: Feature or database schema unavailable }
 * /admin/contract-abi-submissions:
 *   get:
 *     summary: List contract ABI submissions for moderation
 *     tags: [Admin]
 *     parameters:
 *       - in: header
 *         name: X-Admin-Token
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, approved, rejected, published] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *     responses:
 *       200: { description: Paginated submissions with freshness metadata and transition events }
 *       401: { description: Admin authentication failed }
 *       503: { description: Feature or database schema unavailable }
 * /admin/contract-abi-submissions/{id}/approve:
 *   post:
 *     summary: Approve a pending contract ABI submission
 *     tags: [Admin]
 *     parameters:
 *       - in: header
 *         name: X-Admin-Token
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { reviewNote: { type: string, maxLength: 2000 } } }
 *     responses:
 *       200: { description: Submission approved }
 *       409: { description: Submission is not pending }
 * /admin/contract-abi-submissions/{id}/reject:
 *   post:
 *     summary: Reject a pending contract ABI submission
 *     tags: [Admin]
 *     parameters:
 *       - in: header
 *         name: X-Admin-Token
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [reviewNote], properties: { reviewNote: { type: string, minLength: 1, maxLength: 2000 } } }
 *     responses:
 *       200: { description: Submission rejected }
 *       409: { description: Submission is not pending }
 * /admin/contract-abi-submissions/{id}/publish:
 *   post:
 *     summary: Publish an approved ABI into the contract registry
 *     tags: [Admin]
 *     parameters:
 *       - in: header
 *         name: X-Admin-Token
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: ABI published after evidence revalidation }
 *       409: { description: Submission is not approved }
 *       422: { description: Indexed evidence is no longer available }
 */
contractAbiSubmissionsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = submissionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      contractAbiSubmissionOperations.inc({ operation: 'submit', outcome: 'invalid' });
      return res.status(400).json({
        error: 'Invalid submission payload',
        code: 'INVALID_SUBMISSION',
        details: parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
      });
    }
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > 65_536) {
      contractAbiSubmissionOperations.inc({ operation: 'submit', outcome: 'invalid' });
      return res.status(413).json({ error: 'Submission payload exceeds 64 KiB', code: 'PAYLOAD_TOO_LARGE' });
    }
    if (parsed.data.network !== config.stellarNetwork) {
      contractAbiSubmissionOperations.inc({ operation: 'submit', outcome: 'invalid' });
      return res.status(422).json({
        error: 'Submission network must match the active indexed network',
        code: 'NETWORK_DATA_UNAVAILABLE',
      });
    }

    try {
      const { submission, duplicate } = await createContractAbiSubmission(
        parsed.data,
        req.apiKey!.developerId,
      );
      contractAbiSubmissionOperations.inc({ operation: 'submit', outcome: duplicate ? 'duplicate' : 'success' });
      logger.info('contract ABI submission recorded', {
        submissionId: submission.id,
        address: submission.address,
        network: submission.network,
        developerId: req.apiKey!.developerId,
        duplicate,
      });
      return res.status(duplicate ? 200 : 201).json({ submission, duplicate });
    } catch (error) {
      contractAbiSubmissionOperations.inc({
        operation: 'submit',
        outcome: isExpectedRejection(error) ? 'rejected' : 'error',
      });
      throw error;
    }
  }),
);

export const contractAbiSubmissionsAdminRouter = Router();
contractAbiSubmissionsAdminRouter.use(adminAuth, featureGate);

contractAbiSubmissionsAdminRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid list parameters', code: 'INVALID_QUERY' });
    }
    try {
      const result = await listContractAbiSubmissions(
        parsed.data.status,
        parsed.data.page,
        parsed.data.limit,
      );
      contractAbiSubmissionOperations.inc({ operation: 'review', outcome: 'success' });
      return res.json(result);
    } catch (error) {
      contractAbiSubmissionOperations.inc({
        operation: 'review',
        outcome: isExpectedRejection(error) ? 'rejected' : 'error',
      });
      throw error;
    }
  }),
);

contractAbiSubmissionsAdminRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const submission = await getContractAbiSubmission(req.params.id);
      contractAbiSubmissionOperations.inc({ operation: 'review', outcome: 'success' });
      return res.json(submission);
    } catch (error) {
      contractAbiSubmissionOperations.inc({
        operation: 'review',
        outcome: isExpectedRejection(error) ? 'rejected' : 'error',
      });
      throw error;
    }
  }),
);

contractAbiSubmissionsAdminRouter.post(
  '/:id/approve',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = approveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid review payload',
        code: 'INVALID_REVIEW',
        details: parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
      });
    }
    try {
      const args: [string, 'approved', string, (string | undefined)?, (TrustLevel | undefined)?, (ContractMetadataProvenance | undefined)?] = [
        req.params.id,
        'approved',
        req.actor ?? 'admin',
      ];
      if (parsed.data.reviewNote !== undefined || parsed.data.trustLevel !== undefined || parsed.data.provenance !== undefined) {
        args.push(parsed.data.reviewNote);
      }
      if (parsed.data.trustLevel !== undefined || parsed.data.provenance !== undefined) {
        args.push(parsed.data.trustLevel);
      }
      if (parsed.data.provenance !== undefined) {
        args.push(parsed.data.provenance);
      }

      const submission = await reviewContractAbiSubmission(...(args as Parameters<typeof reviewContractAbiSubmission>));
      contractAbiSubmissionOperations.inc({ operation: 'review', outcome: 'success' });
      logger.info('contract ABI submission approved', { submissionId: submission.id, actor: req.actor ?? 'admin' });
      return res.json({ submission });
    } catch (error) {
      contractAbiSubmissionOperations.inc({
        operation: 'review',
        outcome: isExpectedRejection(error) ? 'rejected' : 'error',
      });
      throw error;
    }
  }),
);

contractAbiSubmissionsAdminRouter.post(
  '/:id/reject',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = reviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'A rejection reason is required', code: 'INVALID_REVIEW' });
    try {
      const submission = await reviewContractAbiSubmission(
        req.params.id,
        'rejected',
        req.actor ?? 'admin',
        parsed.data.reviewNote,
      );
      contractAbiSubmissionOperations.inc({ operation: 'review', outcome: 'success' });
      logger.info('contract ABI submission rejected', { submissionId: submission.id, actor: req.actor ?? 'admin' });
      return res.json({ submission });
    } catch (error) {
      contractAbiSubmissionOperations.inc({
        operation: 'review',
        outcome: isExpectedRejection(error) ? 'rejected' : 'error',
      });
      throw error;
    }
  }),
);

contractAbiSubmissionsAdminRouter.post(
  '/:id/publish',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const submission = await publishContractAbiSubmission(req.params.id, req.actor ?? 'admin');
      contractAbiSubmissionOperations.inc({ operation: 'publish', outcome: 'success' });
      logger.info('contract ABI submission published', {
        submissionId: submission.id,
        address: submission.address,
        network: submission.network,
        actor: req.actor ?? 'admin',
      });
      return res.json({ submission });
    } catch (error) {
      contractAbiSubmissionOperations.inc({
        operation: 'publish',
        outcome: isExpectedRejection(error) ? 'rejected' : 'error',
      });
      throw error;
    }
  }),
);
