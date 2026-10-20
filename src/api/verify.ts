import { Prisma } from '@prisma/client';
import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { prismaWrite as prisma } from '../db';
import {
  extractArchive,
  compileSandboxed,
  hashFile,
  cleanupDir,
  extractSourceFiles,
  ToolchainEnum,
} from './compiler';
import { decompileWasm } from '../indexer/wasm-decompiler';
import { asyncHandler } from '../middleware/asyncHandler';
import { singleFileUpload } from '../middleware/uploadValidation';
import { background } from '../utils/background';

export const verifyRouter = Router();

// Size limits, filename/extension/MIME pre-checks and the authoritative
// magic-byte check live in middleware/uploadValidation.ts (#1238). After it
// runs, req.file.mimetype is the *detected* type, not the client's claim.
const upload = singleFileUpload('archive', 'archive');

// POST /verify — submit a source archive for verification
verifyRouter.post(
  '/',
  upload,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No archive uploaded. Use field name "archive".' });
      return;
    }

    const schema = z.object({
      contractAddress: z.string().optional(),
      toolchain: ToolchainEnum.optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      await cleanupDir(req.file.path);
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { contractAddress, toolchain = 'soroban-cli@0.9.4' } = parsed.data;

    // Magic bytes were verified by the upload middleware.
    const detectedMimeType = req.file.mimetype;

    // Hash the raw archive for deduplication / audit
    const uploadedHash = hashFile(req.file.path);

    // Create the job record immediately so the client can poll
    const job = await prisma.verificationJob.create({
      data: { contractAddress, toolchain, status: 'pending', uploadedHash },
    });

    // Run compilation asynchronously — do not await
    runVerification(job.id, req.file.path, detectedMimeType, toolchain, contractAddress).catch(
      () => {
        // errors are persisted inside runVerification
      },
    );

    res.status(202).json({ jobId: job.id, status: 'pending' });
  }),
);

// GET /verify/:id — poll job status
verifyRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const job = await prisma.verificationJob.findUnique({ where: { id: req.params.id } });
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  }),
);

// GET /verify/:id/snippet — return extracted source code files for a verification job
verifyRouter.get(
  '/:id/snippet',
  asyncHandler(async (req: Request, res: Response) => {
    const job = await prisma.verificationJob.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, sourceFiles: true },
    });
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (!job.sourceFiles) {
      res.status(404).json({
        error: 'Source files not available. Job may still be pending or failed before extraction.',
      });
      return;
    }
    res.json({ jobId: job.id, status: job.status, files: job.sourceFiles });
  }),
);

// ── async worker ─────────────────────────────────────────────────────────────

async function runVerification(
  jobId: string,
  archivePath: string,
  mimeType: string,
  toolchain: string,
  contractAddress?: string,
): Promise<void> {
  let extractedDir: string | null = null;

  try {
    await prisma.verificationJob.update({ where: { id: jobId }, data: { status: 'compiling' } });

    extractedDir = await extractArchive(archivePath, mimeType);

    // Capture source files before compilation (they get cleaned up after)
    const sourceFiles = await extractSourceFiles(extractedDir).catch((): never[] => []);
    if (sourceFiles.length > 0) {
      await prisma.verificationJob.update({
        where: { id: jobId },
        data: { sourceFiles: sourceFiles as unknown as Prisma.InputJsonValue },
      });
    }

    const { wasmHash, logs } = await compileSandboxed(extractedDir, toolchain);

    // Optionally fetch on-chain Wasm hash via RPC
    let onChainWasmHash: string | null = null;
    if (contractAddress) {
      onChainWasmHash = await fetchOnChainHash(contractAddress).catch((): null => null);
    }

    const matched = onChainWasmHash != null ? wasmHash === onChainWasmHash : null;

    await prisma.verificationJob.update({
      where: { id: jobId },
      data: {
        status: 'verified',
        compiledWasmHash: wasmHash,
        onChainWasmHash,
        matched,
        logs,
      },
    });
  } catch (err: any) {
    background('verify.updateJobFailed', () =>
      prisma.verificationJob
        .update({
          where: { id: jobId },
          data: { status: 'failed', errorMsg: err.message ?? String(err) },
        })
        .then(() => {}),
    );
  } finally {
    if (extractedDir) await cleanupDir(path.dirname(extractedDir));
    await cleanupDir(archivePath);
  }
}

/**
 * Fetches the Wasm hash for a deployed contract from the Stellar RPC.
 * Returns the hex-encoded SHA-256 of the contract's Wasm bytecode.
 */
async function fetchOnChainHash(contractAddress: string): Promise<string> {
  const { SorobanRpc, Contract } = await import('@stellar/stellar-sdk');
  const rpcUrl = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const server = new SorobanRpc.Server(rpcUrl);

  // getLedgerEntries for the contract's Wasm entry
  const contract = new Contract(contractAddress);
  const key = contract.getFootprint();
  const resp = await server.getLedgerEntries(key);

  if (!resp.entries?.length) throw new Error('Contract not found on-chain');

  const entry = resp.entries[0];
  // The Wasm hash is stored in the contract instance ledger entry
  const wasmHash = (entry.val as Record<string, unknown>)?.contract_code?.hash;
  if (!wasmHash) throw new Error('Could not extract Wasm hash from ledger entry');

  return Buffer.from(wasmHash).toString('hex');
}

// ── Wasm Byte-Decompiler endpoint ─────────────────────────────────────────────

// Accept raw .wasm uploads up to 10 MB for decompile analysis
const wasmUpload = singleFileUpload('wasm', 'wasm');

/**
 * POST /verify/decompile
 *
 * Upload a raw compiled Wasm binary.  The endpoint:
 *   1. Parses the binary into an analytical index of distinct opcode strings.
 *   2. Matches the opcode sequence against known vulnerable contract templates.
 *   3. Returns a warning if malicious backdoors or admin-drain patterns are found.
 *
 * Multipart field name: "wasm"
 */
verifyRouter.post(
  '/decompile',
  wasmUpload,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No Wasm file uploaded. Use multipart field name "wasm".' });
      return;
    }

    let wasmBytes: Buffer;
    try {
      wasmBytes = await fs.promises.readFile(req.file.path);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to read uploaded file', detail: String(err) });
      return;
    } finally {
      // Best-effort cleanup of temp file
      background('verify.cleanupTempFile', async () => {
        await fs.promises.unlink(req.file!.path);
      });
    }

    // Wasm magic header was verified by the upload middleware.
    let result;
    try {
      result = decompileWasm(wasmBytes);
    } catch (err: any) {
      res
        .status(422)
        .json({ error: 'Failed to decompile Wasm binary', detail: err.message ?? String(err) });
      return;
    }

    res.json({
      totalOpcodes: result.opcodeIndex.totalOpcodes,
      distinctOpcodes: result.opcodeIndex.distinctOpcodes,
      opcodeFrequency: result.opcodeIndex.frequency,
      hasVulnerabilities: result.hasVulnerabilities,
      vulnerabilities: result.vulnerabilities,
      warningMessage: result.warningMessage,
    });
  }),
);
