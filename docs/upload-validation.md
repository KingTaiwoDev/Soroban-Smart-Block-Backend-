# Upload size and content validation

Every endpoint that accepts file content uses `src/middleware/uploadValidation.ts`.

| Endpoint | Field | Kind | Max size |
| --- | --- | --- | --- |
| `POST /api/v1/verify` | `archive` | `.tar.gz` / `.tgz` / `.zip` | 50 MB |
| `POST /api/v1/compiler/compile` | `source` | `.tar.gz` / `.tgz` / `.zip` | 50 MB |
| `POST /api/v1/compiler/verify` | `source` | `.tar.gz` / `.tgz` / `.zip` | 50 MB |
| `POST /api/v1/verify/decompile` | `wasm` | `.wasm` | 10 MB |
| `POST /api/v1/sandbox/templates` | `wasmBase64` (JSON) | base64 Wasm | 10 MB decoded, also capped by the 1 MB JSON body limit |

## Checks, in order

1. The request must be `multipart/form-data`, or it gets `415 UNSUPPORTED_MEDIA_TYPE`.
2. A declared `Content-Length` larger than the file limit plus 1 MB of multipart
   overhead gets `413 UPLOAD_TOO_LARGE` before any bytes are parsed.
3. While the body streams in: exactly one file in the named field, at most 10
   text fields of up to 64 KB each, and the per-file byte limit (`413`).
4. The filename must be safe (no path separators, `..`, NUL, or leading dot),
   the extension must be allowed (`400 INVALID_UPLOAD`), and the client MIME type
   must be allowed (`415`).
5. **Magic bytes are the authoritative check:** gzip `1f 8b`, zip `50 4b 03 04`,
   Wasm `00 61 73 6d`. A mismatch gets `400 INVALID_UPLOAD_CONTENT`. On success,
   `req.file.mimetype` is replaced with the detected type.

Every rejected upload has its temp file deleted. Error bodies are
`{ "error": string, "code": string }`, and a `413` also includes `maxBytes`.

## Compatibility / rollout

- The global `requestSizeGuard` still caps non-multipart bodies at 1 MB. It now
  lets `multipart/form-data` requests through up to 51 MB, the largest upload
  boundary, and the per-route limits above apply after that. Before this change,
  any upload over 1 MB was rejected with a generic 413, even though the routes
  advertise 50 MB / 10 MB limits.
- `/compiler/compile` and `/compiler/verify` now apply the same filename, MIME
  and magic-byte checks as `/verify`. Archives are extracted by their detected
  type, not the client-supplied MIME type. Clients that sent `application/x-gzip`
  used to fail with "Unsupported archive format" and now work.
- Upload errors that used to fall through to the generic error handler (an
  oversized file, a bad extension, or a bad MIME type) now return structured
  4xx responses instead of 500.
- `POST /sandbox/templates` now rejects a `wasmBase64` that is present but is
  not valid base64 Wasm.
- Limits are the same on every network (testnet, mainnet, devnet). Ingress or
  proxy body limits (for example nginx `client_max_body_size`) must allow at
  least 51 MB on these routes.
