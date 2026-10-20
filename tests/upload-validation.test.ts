/**
 * Upload size and content validation at every upload boundary (#1238).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  decodeBase64Wasm,
  detectUploadContentType,
  isSafeUploadFilename,
  MAX_MULTIPART_REQUEST_BYTES,
  singleFileUpload,
  UPLOAD_LIMITS,
  UploadValidationError,
} from '../src/middleware/uploadValidation';
import { requestSizeGuard } from '../src/middleware/sanitize';

const GZIP = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(60)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);

let uploadDir: string;

beforeAll(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-validation-test-'));
});

afterAll(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

const remainingUploads = () => fs.readdirSync(uploadDir);

function buildApp(kind: 'archive' | 'wasm', maxBytes = 1024) {
  const app = express();
  app.post('/upload', singleFileUpload('file', kind, { maxBytes, dest: uploadDir }), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'missing file' });
    const { mimetype, size, path: filePath } = req.file;
    fs.unlinkSync(filePath);
    return res.json({ mimetype, size, body: req.body });
  });
  return app;
}

describe('content detection helpers', () => {
  it('detects archives and Wasm from magic bytes', () => {
    expect(detectUploadContentType(GZIP)).toBe('application/gzip');
    expect(detectUploadContentType(ZIP)).toBe('application/zip');
    expect(detectUploadContentType(WASM)).toBe('application/wasm');
    expect(detectUploadContentType(ELF)).toBeNull();
    expect(detectUploadContentType(Buffer.alloc(0))).toBeNull();
    expect(detectUploadContentType(Buffer.from([0x1f]))).toBeNull();
  });

  it('accepts plain filenames and rejects traversal / control characters', () => {
    expect(isSafeUploadFilename('contract-v1.tar.gz')).toBe(true);
    expect(isSafeUploadFilename('../etc/passwd')).toBe(false);
    expect(isSafeUploadFilename('a..b.zip')).toBe(false);
    expect(isSafeUploadFilename('.hidden.zip')).toBe(false);
    expect(isSafeUploadFilename('evil\0.zip')).toBe(false);
    expect(isSafeUploadFilename('a$b.zip')).toBe(false);
  });

  it('exposes consistent limits for the global multipart guard', () => {
    expect(UPLOAD_LIMITS.sourceArchiveBytes).toBe(50 * 1024 * 1024);
    expect(UPLOAD_LIMITS.wasmBytes).toBe(10 * 1024 * 1024);
    expect(MAX_MULTIPART_REQUEST_BYTES).toBeGreaterThan(UPLOAD_LIMITS.sourceArchiveBytes);
  });
});

describe('singleFileUpload — archives', () => {
  const app = buildApp('archive');

  it.each([
    ['gzip', 'src.tar.gz', 'application/gzip', GZIP, 'application/gzip'],
    ['gzip sent as octet-stream', 'src.tgz', 'application/octet-stream', GZIP, 'application/gzip'],
    ['zip', 'src.zip', 'application/zip', ZIP, 'application/zip'],
  ])('accepts a valid %s archive and reports the detected type', async (...args) => {
    const [, filename, contentType, bytes, detected] = args;
    const res = await request(app)
      .post('/upload')
      .field('toolchain', 'soroban-cli@0.9.4')
      .attach('file', bytes, { filename, contentType });
    expect(res.status).toBe(200);
    expect(res.body.mimetype).toBe(detected);
    expect(res.body.body.toolchain).toBe('soroban-cli@0.9.4');
  });

  it('overrides a spoofed client MIME type with the detected one', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', ZIP, { filename: 'src.tar.gz', contentType: 'application/gzip' });
    expect(res.status).toBe(200);
    expect(res.body.mimetype).toBe('application/zip');
  });

  it('rejects files larger than the limit with 413', async () => {
    const big = Buffer.concat([GZIP, Buffer.alloc(2048)]);
    const res = await request(app)
      .post('/upload')
      .attach('file', big, { filename: 'src.tar.gz', contentType: 'application/gzip' });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: 'UPLOAD_TOO_LARGE', maxBytes: 1024 });
    expect(remainingUploads()).toEqual([]);
  });

  it('rejects a declared Content-Length above the limit before parsing', () => {
    const middleware = singleFileUpload('file', 'archive', { maxBytes: 1024, dest: uploadDir });
    const req = {
      is: () => 'multipart/form-data',
      headers: { 'content-length': String(1024 + 2 * 1024 * 1024) },
    } as unknown as express.Request;
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        sent.body = body;
        return this;
      },
    } as unknown as express.Response;
    let calledNext = false;

    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(false);
    expect(sent.status).toBe(413);
    expect(sent.body?.code).toBe('UPLOAD_TOO_LARGE');
  });

  it('rejects content that does not match the extension (magic bytes)', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', ELF, { filename: 'src.tar.gz', contentType: 'application/gzip' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_UPLOAD_CONTENT');
    expect(remainingUploads()).toEqual([]);
  });

  it('rejects Wasm bytes on an archive boundary', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', WASM, { filename: 'src.zip', contentType: 'application/zip' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_UPLOAD_CONTENT');
  });

  it('rejects disallowed extensions', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', GZIP, { filename: 'src.exe', contentType: 'application/gzip' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_UPLOAD');
  });

  it('rejects unsafe filenames', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', GZIP, { filename: 'a$b.tar.gz', contentType: 'application/gzip' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid filename');
  });

  it('rejects disallowed client MIME types with 415', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', GZIP, { filename: 'src.tar.gz', contentType: 'text/html' });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects files sent under an unexpected field name', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('other', GZIP, { filename: 'src.tar.gz', contentType: 'application/gzip' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_UPLOAD');
  });

  it('rejects more than one file', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', GZIP, { filename: 'a.tar.gz', contentType: 'application/gzip' })
      .attach('file', GZIP, { filename: 'b.tar.gz', contentType: 'application/gzip' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(remainingUploads()).toEqual([]);
  });

  it('rejects oversized text fields', async () => {
    const res = await request(app)
      .post('/upload')
      .field('toolchain', 'x'.repeat(UPLOAD_LIMITS.maxFieldBytes + 1))
      .attach('file', GZIP, { filename: 'src.tar.gz', contentType: 'application/gzip' });
    expect(res.status).toBe(413);
  });

  it('rejects non-multipart bodies with 415', async () => {
    const res = await request(app).post('/upload').send({ file: GZIP.toString('base64') });
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('passes through to the handler when no file is attached', async () => {
    const res = await request(app).post('/upload').field('toolchain', 'soroban-cli@0.9.4');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing file');
  });
});

describe('singleFileUpload — Wasm', () => {
  const app = buildApp('wasm');

  it('accepts a valid Wasm module', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', WASM, { filename: 'contract.wasm', contentType: 'application/wasm' });
    expect(res.status).toBe(200);
    expect(res.body.mimetype).toBe('application/wasm');
  });

  it('rejects a renamed archive', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', ZIP, { filename: 'contract.wasm', contentType: 'application/wasm' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File content is not a valid Wasm binary');
    expect(remainingUploads()).toEqual([]);
  });

  it('rejects oversize Wasm with 413', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.concat([WASM, Buffer.alloc(2048)]), {
        filename: 'contract.wasm',
        contentType: 'application/wasm',
      });
    expect(res.status).toBe(413);
  });
});

describe('decodeBase64Wasm (JSON upload boundary)', () => {
  it('decodes valid base64 Wasm', () => {
    expect(decodeBase64Wasm(WASM.toString('base64'))).toEqual(WASM);
  });

  it.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['invalid base64', '***not-base64***'],
    ['non-Wasm bytes', ELF.toString('base64')],
  ])('rejects %s with 400', (_label, value) => {
    try {
      decodeBase64Wasm(value);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(UploadValidationError);
      expect((err as UploadValidationError).status).toBe(400);
    }
  });

  it('rejects payloads above the limit with 413 before decoding', () => {
    const big = Buffer.concat([WASM, Buffer.alloc(64)]).toString('base64');
    try {
      decodeBase64Wasm(big, 16);
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as UploadValidationError).status).toBe(413);
      expect((err as UploadValidationError).code).toBe('UPLOAD_TOO_LARGE');
    }
  });
});

describe('requestSizeGuard multipart allowance', () => {
  function guardApp() {
    const app = express();
    app.use(requestSizeGuard(100, { multipartLimitBytes: 1000 }));
    app.post('/x', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('keeps the small limit for JSON bodies', async () => {
    const res = await request(guardApp())
      .post('/x')
      .send({ pad: 'x'.repeat(200) });
    expect(res.status).toBe(413);
  });

  it('allows multipart bodies up to the multipart limit', async () => {
    const res = await request(guardApp())
      .post('/x')
      .attach('file', Buffer.alloc(300), { filename: 'a.zip', contentType: 'application/zip' });
    expect(res.status).toBe(200);
  });

  it('rejects multipart bodies above the multipart limit', async () => {
    const res = await request(guardApp())
      .post('/x')
      .attach('file', Buffer.alloc(2000), { filename: 'a.zip', contentType: 'application/zip' });
    expect(res.status).toBe(413);
  });

  it('defaults the multipart limit to the regular limit (backwards compatible)', async () => {
    const app = express();
    app.use(requestSizeGuard(100));
    app.post('/x', (_req, res) => res.json({ ok: true }));
    const res = await request(app)
      .post('/x')
      .attach('file', Buffer.alloc(300), { filename: 'a.zip', contentType: 'application/zip' });
    expect(res.status).toBe(413);
  });
});

describe('every upload boundary uses the shared validation', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it.each(['src/api/verify.ts', 'src/api/compiler-router.ts'])(
    '%s does not configure multer directly',
    (file) => {
      const source = read(file);
      expect(source).not.toMatch(/from 'multer'/);
      expect(source).toMatch(/singleFileUpload\(/);
    },
  );

  it('sandbox template submission validates embedded Wasm', () => {
    expect(read('src/api/sandbox.ts')).toMatch(/decodeBase64Wasm\(/);
  });

  it('the global size guard admits the largest upload boundary', () => {
    expect(read('src/app.ts')).toMatch(/multipartLimitBytes: MAX_MULTIPART_REQUEST_BYTES/);
  });
});
