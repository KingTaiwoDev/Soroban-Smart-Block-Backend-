import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import { contractAbiSubmissionValidationDuration } from '../metrics';
import { AppError } from '../middleware/errorHandler';

export interface AbiFunctionSubmission {
  name: string;
  inputs: Array<{ name: string; type: string }>;
  outputs?: Array<{ type: string }>;
  humanTemplate?: string;
}

export interface AbiEventSubmission {
  name: string;
  inputs?: Array<{ name: string; type: string }>;
}

export type TrustLevel = 'unverified' | 'community' | 'verified_publisher' | 'canonical' | 'official';

export const TRUST_LEVEL_HIERARCHY: Record<TrustLevel, number> = {
  unverified: 0,
  community: 1,
  verified_publisher: 2,
  canonical: 3,
  official: 4,
};

export interface ContractMetadataProvenance {
  source?: string;
  repoUrl?: string;
  commitHash?: string;
  submitterIdentity?: string;
  attestationUrl?: string;
  signature?: string;
  signerAddress?: string;
  verifiedAt?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ContractAbiSubmissionInput {
  address: string;
  network: 'testnet' | 'mainnet' | 'devnet';
  name?: string;
  description?: string;
  abi: { functions: AbiFunctionSubmission[]; events?: AbiEventSubmission[] };
  abiVersion?: string;
  version?: string;
  wasmHash?: string;
  protocolKey?: string;
  deployedAtLedger?: number;
  trustLevel?: TrustLevel;
  provenance?: ContractMetadataProvenance;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function observedEvidence(
  client: Pick<Prisma.TransactionClient, 'transaction' | 'event'> | typeof prismaRead,
  address: string,
  abi: ContractAbiSubmissionInput['abi'],
): Promise<{ ledger: number; observedFunctions: string[]; observedEvents: string[] }> {
  const startedAt = performance.now();
  try {
    const [transactionRows, eventRows] = await Promise.all([
      abi.functions.length
        ? client.transaction.findMany({
            where: {
              contractAddress: address,
              functionName: { in: abi.functions.map((fn) => fn.name) },
            },
            select: { functionName: true, ledgerSequence: true },
            orderBy: { ledgerSequence: 'desc' },
            take: 1000,
          })
        : Promise.resolve([]),
      abi.events?.length
        ? client.event.findMany({
            where: {
              contractAddress: address,
              topicSymbol: { in: abi.events.map((event) => event.name) },
            },
            select: { topicSymbol: true, ledgerSequence: true },
            orderBy: { ledgerSequence: 'desc' },
            take: 1000,
          })
        : Promise.resolve([]),
    ]);

    const observedFunctions = [
      ...new Set(transactionRows.flatMap((row) => (row.functionName ? [row.functionName] : []))),
    ];
    const observedEvents = [...new Set(eventRows.flatMap((row) => (row.topicSymbol ? [row.topicSymbol] : [])))];
    if (observedFunctions.length === 0 && observedEvents.length === 0) {
      throw new AppError(422, 'No submitted ABI function or event has been observed in indexed activity');
    }

    return {
      ledger: [...transactionRows, ...eventRows].reduce(
        (latest, row) => Math.max(latest, row.ledgerSequence),
        0,
      ),
      observedFunctions,
      observedEvents,
    };
  } finally {
    contractAbiSubmissionValidationDuration.observe((performance.now() - startedAt) / 1000);
  }
}

export async function createContractAbiSubmission(
  input: ContractAbiSubmissionInput,
  submittedBy: string,
) {
  const serializedPayload = canonicalJson(input);
  const contentHash = sha256(serializedPayload);
  const existing = await prismaWrite.contractAbiSubmission.findFirst({
    where: { address: input.address, network: input.network, submittedBy, contentHash },
  });
  if (existing) return { submission: existing, duplicate: true };

  const evidence = await observedEvidence(prismaRead, input.address, input.abi);
  const payload = JSON.parse(serializedPayload) as Prisma.InputJsonValue;

  try {
    const submission = await prismaWrite.$transaction(async (tx) => {
      const created = await tx.contractAbiSubmission.create({
        data: {
          address: input.address,
          network: input.network,
          submittedBy,
          payload,
          contentHash,
          status: 'pending',
          validatedAt: new Date(),
          validationLedger: evidence.ledger,
          trustLevel: input.trustLevel ?? 'unverified',
          provenance: (input.provenance ?? null) as Prisma.InputJsonValue,
        },
      });
      await tx.contractAbiSubmissionEvent.create({
        data: {
          submissionId: created.id,
          fromStatus: null,
          toStatus: 'pending',
          actor: submittedBy,
          reason: `Validated indexed activity; functions: ${evidence.observedFunctions.join(', ') || 'none'}; events: ${evidence.observedEvents.join(', ') || 'none'}`,
        },
      });
      return created;
    });
    return { submission, duplicate: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const replay = await prismaWrite.contractAbiSubmission.findFirst({
        where: { address: input.address, network: input.network, submittedBy, contentHash },
      });
      if (replay) return { submission: replay, duplicate: true };
    }
    throw error;
  }
}

export async function listContractAbiSubmissions(status: string | undefined, page: number, limit: number) {
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    prismaWrite.contractAbiSubmission.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: { events: { orderBy: { createdAt: 'asc' } } },
    }),
    prismaWrite.contractAbiSubmission.count({ where }),
  ]);
  const asOf = new Date();
  const validationTimes = items.map((item) => item.validatedAt.getTime());
  const latestValidation = validationTimes.length ? Math.max(...validationTimes) : 0;
  const oldestValidation = validationTimes.length ? Math.min(...validationTimes) : 0;
  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    freshness: {
      asOf: asOf.toISOString(),
      lastValidatedAt: latestValidation ? new Date(latestValidation).toISOString() : null,
      oldestValidatedAt: oldestValidation ? new Date(oldestValidation).toISOString() : null,
      maxStalenessSeconds: oldestValidation
        ? Math.floor((asOf.getTime() - oldestValidation) / 1000)
        : null,
    },
  };
}

export async function getContractAbiSubmission(id: string) {
  const item = await prismaWrite.contractAbiSubmission.findUnique({
    where: { id },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
  if (!item) throw new AppError(404, 'Contract ABI submission not found');
  return item;
}

export async function reviewContractAbiSubmission(
  id: string,
  decision: 'approved' | 'rejected',
  actor: string,
  reviewNote?: string,
  trustLevel?: TrustLevel,
  provenance?: ContractMetadataProvenance,
) {
  return prismaWrite.$transaction(async (tx) => {
    const changed = await tx.contractAbiSubmission.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: decision,
        reviewNote,
        reviewedBy: actor,
        reviewedAt: new Date(),
        ...(trustLevel ? { trustLevel } : {}),
        ...(provenance ? { provenance: provenance as Prisma.InputJsonValue } : {}),
      },
    });
    if (changed.count !== 1) {
      const current = await tx.contractAbiSubmission.findUnique({ where: { id }, select: { id: true } });
      if (!current) throw new AppError(404, 'Contract ABI submission not found');
      throw new AppError(409, 'Only pending submissions can be reviewed');
    }
    await tx.contractAbiSubmissionEvent.create({
      data: {
        submissionId: id,
        fromStatus: 'pending',
        toStatus: decision,
        actor,
        reason: reviewNote,
      },
    });
    return tx.contractAbiSubmission.findUniqueOrThrow({ where: { id } });
  });
}

export async function publishContractAbiSubmission(id: string, actor: string) {
  return prismaWrite.$transaction(async (tx) => {
    const submission = await tx.contractAbiSubmission.findUnique({ where: { id } });
    if (!submission) throw new AppError(404, 'Contract ABI submission not found');
    if (submission.status !== 'approved') {
      throw new AppError(409, 'Only approved submissions can be published');
    }

    const payload = submission.payload as unknown as ContractAbiSubmissionInput;
    const evidence = await observedEvidence(tx, submission.address, payload.abi);
    const abiJson = payload.abi as unknown as Prisma.InputJsonValue;
    const abiHash = sha256(canonicalJson(payload.abi));
    const existingDeployment = await tx.contractNetwork.findUnique({
      where: { address_network: { address: submission.address, network: submission.network } },
      select: { contractId: true },
    });
    const existingCanonical = existingDeployment
      ? await tx.contract.findUnique({
          where: { id: existingDeployment.contractId },
          select: { address: true },
        })
      : null;
    const canonicalAddress = existingCanonical?.address ?? submission.address;

    const contract = await tx.contract.upsert({
      where: { address: canonicalAddress },
      create: {
        address: canonicalAddress,
        ...(canonicalAddress === submission.address && payload.name !== undefined
          ? { name: payload.name }
          : {}),
        ...(canonicalAddress === submission.address && payload.description !== undefined
          ? { description: payload.description }
          : {}),
        ...(canonicalAddress === submission.address ? { abi: abiJson } : {}),
        ...(canonicalAddress === submission.address
          ? {
              trustLevel: submission.trustLevel,
              provenance: submission.provenance as Prisma.InputJsonValue,
            }
          : {}),
      },
      update: {
        ...(canonicalAddress === submission.address && payload.name !== undefined
          ? { name: payload.name }
          : {}),
        ...(canonicalAddress === submission.address && payload.description !== undefined
          ? { description: payload.description }
          : {}),
        ...(canonicalAddress === submission.address ? { abi: abiJson } : {}),
        ...(canonicalAddress === submission.address
          ? {
              trustLevel: submission.trustLevel,
              provenance: submission.provenance as Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    await tx.contractNetwork.upsert({
      where: { address_network: { address: submission.address, network: submission.network } },
      create: {
        address: submission.address,
        network: submission.network,
        contractId: contract.id,
        abi: abiJson,
        abiHash,
        abiVersion: payload.abiVersion,
        version: payload.version,
        wasmHash: payload.wasmHash,
        protocolKey: payload.protocolKey,
        deployedAtLedger: payload.deployedAtLedger,
        trustLevel: submission.trustLevel,
        provenance: submission.provenance as Prisma.InputJsonValue,
      },
      update: {
        contractId: contract.id,
        abi: abiJson,
        abiHash,
        ...(payload.abiVersion !== undefined ? { abiVersion: payload.abiVersion } : {}),
        ...(payload.version !== undefined ? { version: payload.version } : {}),
        ...(payload.wasmHash !== undefined ? { wasmHash: payload.wasmHash } : {}),
        ...(payload.protocolKey !== undefined ? { protocolKey: payload.protocolKey } : {}),
        ...(payload.deployedAtLedger !== undefined
          ? { deployedAtLedger: payload.deployedAtLedger }
          : {}),
        trustLevel: submission.trustLevel,
        provenance: submission.provenance as Prisma.InputJsonValue,
      },
    });

    const changed = await tx.contractAbiSubmission.updateMany({
      where: { id, status: 'approved' },
      data: {
        status: 'published',
        publishedAt: new Date(),
        validatedAt: new Date(),
        validationLedger: evidence.ledger,
      },
    });
    if (changed.count !== 1) throw new AppError(409, 'Submission state changed during publication');

    await tx.contractAbiSubmissionEvent.create({
      data: {
        submissionId: id,
        fromStatus: 'approved',
        toStatus: 'published',
        actor,
        reason: `Published after indexed activity validation at ledger ${evidence.ledger}; functions: ${evidence.observedFunctions.join(', ') || 'none'}; events: ${evidence.observedEvents.join(', ') || 'none'}`,
      },
    });
    return tx.contractAbiSubmission.findUniqueOrThrow({ where: { id } });
  });
}

export const contractAbiSubmissionInternals = { canonicalJson, observedEvidence, sha256 };
