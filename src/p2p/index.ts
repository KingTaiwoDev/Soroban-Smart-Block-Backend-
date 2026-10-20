import { existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { logger } from '../logger';
import { markNotReady, markReady } from '../readiness';
import { getP2pConfig, recordPeerHeartbeat, setSelfPeerId } from './responsibility';
import {
  answerChallenge,
  setChallengeTransport,
  startChallengeScheduler,
  stopChallengeScheduler,
} from './challenge-scheduler';
import { resolveLedgerLocation, setOnTheFlyIndexer, setQueryForwarder } from './resolve-location';
import { protocolId, topicId } from './config';
import type { QueryLedgerResponseMessage } from './types';

export {
  amIResponsibleFor,
  getRangeCursor,
  getSelfPeerId,
  isP2pEnabled,
  ownersOf,
  refreshOwnedRangeClaims,
  setRangeCursor,
} from './responsibility';
export { getP2pStatusSnapshot } from './status-snapshot';
export { resolveLedgerLocation } from './resolve-location';

/**
 * dist-esm/node-factory.mjs is built by a separate ESM-targeted tsconfig
 * (tsconfig.p2p.json) because the current libp2p ecosystem is ESM-only while
 * this project is CommonJS (see docs/P2P_INDEXER_DESIGN.md §5).
 *
 * CJS ↔ ESM bridge
 * ----------------
 * TypeScript rewrites `import(x)` to a `require()`-based shim under
 * `module: commonjs`, which throws ERR_REQUIRE_ESM against genuine ESM
 * artifacts.  The previous workaround used `new Function('specifier',
 * 'return import(specifier)')` to hide the call from the TypeScript
 * compiler — a code-execution primitive that defeats static analysis and
 * breaks under stricter CSP / sandbox environments.
 *
 * The replacement uses `src/p2p/esm/import-shim.mts`, compiled by
 * tsconfig.p2p.json (module: NodeNext).  Because that file is compiled as
 * ESM, its `import()` is emitted as a real dynamic import.  Node ≥ 22.12
 * supports `require()` of synchronous ESM modules, so this CJS module
 * loads the shim synchronously with `createRequire`, then delegates all
 * further ESM loading through the typed `loadNodeFactory` export — no
 * `new Function(...)` required.
 */

/** Lazily-resolved shim module; populated on first call to loadEsmNodeFactory(). */
let _shim: { loadNodeFactory: () => Promise<typeof import('./esm/node-factory.mjs')> } | null =
  null;

function getShim(): { loadNodeFactory: () => Promise<typeof import('./esm/node-factory.mjs')> } {
  if (_shim) return _shim;
  const shimPath = join(__dirname, '..', '..', 'dist-esm', 'import-shim.mjs');
  // Node ≥ 22.12 supports require() of synchronous ESM modules.
  // createRequire(__filename) produces a require() rooted at this CJS file.
  const req = createRequire(__filename);
  _shim = req(shimPath) as typeof _shim;
  return _shim!;
}

export async function loadEsmNodeFactory(): Promise<typeof import('./esm/node-factory.mjs')> {
  const shimPath = join(__dirname, '..', '..', 'dist-esm', 'import-shim.mjs');
  const nodeFactoryPath = join(__dirname, '..', '..', 'dist-esm', 'node-factory.mjs');
  if (!existsSync(shimPath) || !existsSync(nodeFactoryPath)) {
    const missing = [shimPath, nodeFactoryPath].filter((p) => !existsSync(p));
    const errorMsg =
      `[p2p] Missing P2P ESM artifacts: ${missing.join(', ')}. ` +
      `Run "npm run build" or "tsc -p tsconfig.p2p.json" to generate the dist-esm/ ` +
      `artifacts before starting with P2P_ENABLED=true.`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }
  return getShim().loadNodeFactory();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodeHandle: any = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export async function startP2pNode(): Promise<void> {
  const cfg = getP2pConfig();
  if (!cfg.enabled) {
    logger.info('[p2p] disabled (P2P_ENABLED is not true) — running in single-node mode');
    return;
  }

  markNotReady('p2p');
  const { createP2pNode } = await loadEsmNodeFactory();

  nodeHandle = await createP2pNode({
    listenAddr: cfg.listenAddr,
    announceAddr: cfg.announceAddr,
    bootstrapPeers: cfg.bootstrapPeers,
    identityPath: cfg.identityPath,
    mdnsEnabled: cfg.mdnsEnabled,
    isRelayServer: cfg.isRelayServer,
    gossipTopics: {
      heartbeat: topicId(cfg.network, 'membership'),
      ledgerHeader: topicId(cfg.network, 'ledger-headers'),
      reputation: topicId(cfg.network, 'peer-reputation'),
    },
    streamProtocols: {
      challenge: protocolId(cfg.network, 'challenge'),
      query: protocolId(cfg.network, 'query'),
    },
    gossipCallbacks: {
      onHeartbeat: (msg) => recordPeerHeartbeat(msg.peerId, msg.multiaddrs, msg.timestamp),
      onLedgerHeader: () => {
        // Existence/liveness signal only (design doc §6.1) — actual content always
        // comes from RPC via the normal indexer path, never trusted from gossip.
      },
      onReputationUpdate: () => {
        // Blended into local PeerNode scores by the challenge-scheduler's own
        // bookkeeping; the gossiped value is advisory (design doc §1.4/§6.3).
      },
    },
    streamCallbacks: {
      answerChallenge: (ledgerSeq: number) => answerChallenge(ledgerSeq),
      answerQuery: async (ledgerSeq: number, includeEvents: boolean) =>
        (await resolveLedgerLocation(
          cfg.network,
          ledgerSeq,
          includeEvents,
        )) as QueryLedgerResponseMessage,
    },
  });

  setSelfPeerId(nodeHandle.peerId);
  setChallengeTransport((peerId, ledgerSeq) => nodeHandle.sendChallenge(peerId, ledgerSeq));
  setQueryForwarder((peerId, ledgerSeq, includeEvents) =>
    nodeHandle.sendQuery(peerId, ledgerSeq, includeEvents),
  );

  startChallengeScheduler();

  heartbeatTimer = setInterval(() => {
    nodeHandle
      ?.publishHeartbeat({
        network: cfg.network,
        peerId: nodeHandle.peerId,
        multiaddrs: [],
        ledgerCursor: 0,
      })
      .catch((): undefined => undefined);
  }, cfg.heartbeatIntervalMs);

  markReady('p2p');
  logger.info('[p2p] node started', { network: cfg.network, peerId: nodeHandle.peerId });
}

export async function stopP2pNode(): Promise<void> {
  stopChallengeScheduler();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (nodeHandle) {
    await nodeHandle.stop();
    nodeHandle = null;
    markNotReady('p2p');
  }
}

export function getConnectedPeerCount(): number {
  return nodeHandle ? nodeHandle.connectedPeerCount() : 0;
}

/** Wires the indexer's own single-ledger indexing function as the graceful-degradation fallback. */
export function wireOnTheFlyIndexer(indexSingleLedger: (ledgerSeq: number) => Promise<void>): void {
  setOnTheFlyIndexer(indexSingleLedger);
}
