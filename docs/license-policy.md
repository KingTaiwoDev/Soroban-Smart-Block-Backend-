# Dependency license policy

CI job **Dependency license policy** (`npm run licenses:check`, implemented in
`scripts/check-licenses.mjs`) checks every third-party package in
`package-lock.json` and fails the build when a dependency:

- is licensed under **GPL, AGPL or SSPL** (including `-only` / `-or-later`
  variants), or
- has **no usable license metadata** (missing field, `UNLICENSED`,
  `SEE LICENSE IN ...`).

LGPL, MPL and permissive licenses (MIT, Apache-2.0, ISC, BSD, BlueOak, 0BSD,
CC0, ...) pass. SPDX expressions are honoured: `A OR B` passes if either side
passes (e.g. `node-forge` is `BSD-3-Clause OR GPL-2.0`, so it is accepted under
BSD), while `A AND B` requires every term to pass.

First-party workspace packages (`packages/*`, local plugins) are not checked.
The check reads the lockfile only, so it needs no `npm ci` and is
network-independent. It covers dev dependencies too, because build tooling is
also redistributed in some artifacts.

## Exceptions

Add a reviewed exception to `scripts/license-allowlist.json` as
`"name@version": "reason"`. The reason must say why it is acceptable (for
example, the real license when lockfile metadata is missing) and the entry is
version-pinned, so an upgrade is re-checked. Currently `busboy` and
`streamsearch` are allowlisted: they are MIT but the lockfile omits the field.

## Running locally

```
npm run licenses:check
```

Policy logic is covered by `tests/check-licenses.test.ts`.
