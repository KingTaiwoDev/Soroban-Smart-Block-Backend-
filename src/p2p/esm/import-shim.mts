/**
 * import-shim.mts
 *
 * A tiny ESM shim that provides a type-safe dynamic-import helper for use by
 * the CommonJS layer (src/p2p/index.ts).
 *
 * Why this file exists
 * --------------------
 * TypeScript rewrites `import(x)` to a `require()`-based shim when the
 * compilation target is `module: commonjs` — even for runtime-variable
 * specifiers.  That rewrite breaks loading of genuine ESM artifacts (like
 * dist-esm/node-factory.mjs) with ERR_REQUIRE_ESM.
 *
 * This file is compiled by tsconfig.p2p.json (module: NodeNext), so its
 * `import()` call is emitted as a real dynamic import in the output.
 * Node ≥ 22.12 supports require() of synchronous ESM modules, so the CJS
 * caller loads THIS shim via require(), then delegates all ESM loading
 * through the exported helper — no `new Function(...)` required.
 */

import type * as NodeFactory from './node-factory.mjs';

/**
 * Loads the P2P ESM node-factory module.
 *
 * This is the only file in the project that is allowed to call
 * `import('./node-factory.mjs')`.  All other code must go through this
 * helper so that bundler / sandbox restrictions are handled in one place.
 */
export async function loadNodeFactory(): Promise<typeof NodeFactory> {
  return import('./node-factory.mjs');
}
