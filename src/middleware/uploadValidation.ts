/**
 * Upload boundary validation (#1238).
 *
 * Every endpoint that accepts file content — multipart source archives and Wasm
 * binaries (`/verify`, `/verify/decompile`, `/compiler/compile`,
 * `/compiler/verify`) and base64 Wasm embedded in JSON (`/sandbox/templates`) —
 * goes through this module so size limits and content checks are identical:
 *
 *  1. Declared Content-Length is checked before any bytes are parsed.
 *  2. multer enforces the per-file byte limit while streaming, plus a single
 *     file and a bounded number/size of text fields.
 *  3. Filename, extension and client MIME type are a cheap first pass only —
 *     they are attacker-controlled.
 *  4. The authoritative check is the file's magic bytes. On success
 *     `req.file.mimetype` is overwritten with the detected type, so handlers
 *     never act on the client-supplied value.
 *
 * Errors are JSON `{ error, code }` with 413 (too large), 415 (wrong media
 * type) or 400 (malformed upload / content mismatch). Rejected temp files are
 * removed.
 */
import * as fs from 'fs';
import * as os from 'os';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';

export const UPLOAD_LIMITS = {
  /** Source archives (.tar.gz / .tgz / .zip) for compile and verification. */
  sourceArchiveBytes: 50 * 1024 * 1024,
  /** Raw compiled Wasm binaries. */
  wasmBytes: 10 * 1024 * 1024,
  /** Non-file multipart fields (toolchain, expectedHash, contractAddress…). */
  maxFields: 10,
  maxFieldBytes: 64 * 1024,
} as const;

/** Allowance for multipart framing and text fields on top of the file itself. */
export const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/** Largest multipart request any upload boundary accepts (used by the global size guard). */
export const MAX_MULTIPART_REQUEST_BYTES =
  UPLOAD_LIMITS.sourceArchiveBytes + MULTIPART_OVERHEAD_BYTES;

export type UploadKind = 'archive' | 'wasm';
export type DetectedUploadType = 'application/gzip' | 'application/zip' | 'application/wasm';

interface UploadRule {
  extensions: string[];
  mimeTypes: ReadonlySet<string>;
  detected: ReadonlySet<DetectedUploadType>;
  maxBytes: number;
  extensionError: string;
  contentError: string;
}

const UPLOAD_RULES: Record<UploadKind, UploadRule> = {
  archive: {
    extensions: ['.tar.gz', '.tgz', '.zip'],
    mimeTypes: new Set([
      'application/gzip',
      'application/x-gzip',
      'application/zip',
      'application/x-zip-compressed',
      'application/x-tar',
      'application/octet-stream', // many clients send this for .tar.gz / .zip
    ]),
    detected: new Set<DetectedUploadType>(['application/gzip', 'application/zip']),
    maxBytes: UPLOAD_LIMITS.sourceArchiveBytes,
    extensionError: 'Only .tar.gz / .zip archives are accepted',
    contentError: 'File content does not match a valid .tar.gz or .zip archive',
  },
  wasm: {
    extensions: ['.wasm'],
    mimeTypes: new Set(['application/wasm', 'application/octet-stream']),
    detected: new Set<DetectedUploadType>(['application/wasm']),
    maxBytes: UPLOAD_LIMITS.wasmBytes,
    extensionError: 'Only .wasm files are accepted',
    contentError: 'File content is not a valid Wasm binary',
  },
};

export class UploadValidationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415 = 400,
    readonly code = 'INVALID_UPLOAD',
  ) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

// ── content helpers ──────────────────────────────────────────────────────────

const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/;

export function isSafeUploadFilename(name: string): boolean {
  return SAFE_FILENAME_RE.test(name) && !name.includes('..') && !name.includes('\0');
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** "\0asm" followed by binary format version 1. */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/** Identify an upload from its leading bytes; `null` when unrecognised. */
export function detectUploadContentType(header: Buffer): DetectedUploadType | null {
  if (header.length >= 2 && header.subarray(0, 2).equals(GZIP_MAGIC)) return 'application/gzip';
  if (header.length >= 4 && header.subarray(0, 4).equals(ZIP_MAGIC)) return 'application/zip';
  if (header.length >= 4 && header.subarray(0, 4).equals(WASM_MAGIC)) return 'application/wasm';
  return null;
}

export async function readFileHeader(filePath: string, length = 8): Promise<Buffer> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode and validate base64-encoded Wasm embedded in a JSON body.
 * Throws `UploadValidationError` for non-strings, invalid base64, oversize
 * payloads and bytes that are not a Wasm module.
 */
export function decodeBase64Wasm(
  value: unknown,
  maxBytes: number = UPLOAD_LIMITS.wasmBytes,
): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UploadValidationError('wasmBase64 must be a non-empty base64 string');
  }
  const compact = value.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new UploadValidationError('wasmBase64 is not valid base64');
  }
  // Check the decoded size before allocating it.
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const decodedBytes = (compact.length / 4) * 3 - padding;
  if (decodedBytes > maxBytes) {
    throw new UploadValidationError(
      `Wasm exceeds the ${maxBytes}-byte upload limit`,
      413,
      'UPLOAD_TOO_LARGE',
    );
  }
  const bytes = Buffer.from(compact, 'base64');
  if (detectUploadContentType(bytes) !== 'application/wasm') {
    throw new UploadValidationError('wasmBase64 does not contain a valid Wasm binary');
  }
  return bytes;
}

// ── multipart middleware ─────────────────────────────────────────────────────

async function removeFile(filePath: string | undefined): Promise<void> {
  if (filePath) await fs.promises.unlink(filePath).catch(() => undefined);
}

function sendUploadError(res: Response, err: UploadValidationError, maxBytes: number): void {
  res.status(err.status).json({
    error: err.message,
    code: err.code,
    ...(err.status === 413 ? { maxBytes } : {}),
  });
}

function fromMulterError(err: multer.MulterError, maxBytes: number): UploadValidationError {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return new UploadValidationError(
        `File exceeds the ${maxBytes}-byte upload limit`,
        413,
        'UPLOAD_TOO_LARGE',
      );
    case 'LIMIT_FIELD_VALUE':
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_PART_COUNT':
      return new UploadValidationError(err.message, 413, 'UPLOAD_TOO_LARGE');
    default:
      return new UploadValidationError(err.message);
  }
}

/**
 * Accept exactly one file of `kind` in multipart field `field`, enforcing the
 * shared limits and verifying content by magic bytes.
 */
export function singleFileUpload(
  field: string,
  kind: UploadKind,
  options: { maxBytes?: number; dest?: string } = {},
): RequestHandler {
  const rule = UPLOAD_RULES[kind];
  const maxBytes = options.maxBytes ?? rule.maxBytes;

  const parse = multer({
    dest: options.dest ?? os.tmpdir(),
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: UPLOAD_LIMITS.maxFields,
      fieldSize: UPLOAD_LIMITS.maxFieldBytes,
      parts: UPLOAD_LIMITS.maxFields + 1,
    },
    fileFilter: (_req, file, cb) => {
      if (!isSafeUploadFilename(file.originalname)) {
        cb(new UploadValidationError('Invalid filename'));
        return;
      }
      const name = file.originalname.toLowerCase();
      if (!rule.extensions.some((ext) => name.endsWith(ext))) {
        cb(new UploadValidationError(rule.extensionError));
        return;
      }
      if (!rule.mimeTypes.has(file.mimetype)) {
        cb(
          new UploadValidationError(
            `Unsupported content type: ${file.mimetype}`,
            415,
            'UNSUPPORTED_MEDIA_TYPE',
          ),
        );
        return;
      }
      cb(null, true);
    },
  }).single(field);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.is('multipart/form-data')) {
      sendUploadError(
        res,
        new UploadValidationError(
          `Expected multipart/form-data with a "${field}" file`,
          415,
          'UNSUPPORTED_MEDIA_TYPE',
        ),
        maxBytes,
      );
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes + MULTIPART_OVERHEAD_BYTES) {
      sendUploadError(
        res,
        new UploadValidationError(
          `Request exceeds the ${maxBytes}-byte upload limit`,
          413,
          'UPLOAD_TOO_LARGE',
        ),
        maxBytes,
      );
      return;
    }

    parse(req, res, async (err?: unknown) => {
      if (err) {
        await removeFile(req.file?.path);
        if (err instanceof multer.MulterError) {
          sendUploadError(res, fromMulterError(err, maxBytes), maxBytes);
          return;
        }
        if (err instanceof UploadValidationError) {
          sendUploadError(res, err, maxBytes);
          return;
        }
        next(err);
        return;
      }

      const file = req.file;
      if (!file) {
        next();
        return;
      }

      let detected: DetectedUploadType | null;
      try {
        detected = detectUploadContentType(await readFileHeader(file.path));
      } catch (readErr) {
        await removeFile(file.path);
        next(readErr);
        return;
      }

      if (!detected || !rule.detected.has(detected)) {
        await removeFile(file.path);
        sendUploadError(
          res,
          new UploadValidationError(rule.contentError, 400, 'INVALID_UPLOAD_CONTENT'),
          maxBytes,
        );
        return;
      }

      // Authoritative type for downstream handlers (never the client's claim).
      file.mimetype = detected;
      next();
    });
  };
}
