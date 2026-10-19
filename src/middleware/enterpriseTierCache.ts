/**
 * Enterprise Tier Cache
 *
 * In-memory TTL cache for enterprise custom tier configurations.
 * Keyed by organisation ID. Entries expire after CACHE_TTL_MS (default 5 min)
 * so that admin updates propagate to all running instances within a predictable
 * window without requiring a restart.
 *
 * Design notes:
 *  - Pure in-process Map for fast, non-blocking reads — no Redis dependency on
 *    the critical request path.
 *  - TTL is checked lazily on every read; a periodic sweep is intentionally
 *    omitted to keep the module dependency-free and GC-friendly.
 *  - Cross-replica invalidation (Issue #1284): When an update occurs, an
 *    invalidation message is published to the `__enterprise_tier:invalidate`
 *    channel so peer replicas evict stale entries within sub-second bounds.
 *  - If the invalidation channel is unavailable or Redis is not deployed,
 *    replicas gracefully recover via the 5-minute TTL eviction and emit
 *    diagnostic alerts (ENTERPRISE_TIER_INVALIDATION_DEGRADED).
 */

import { randomUUID } from 'crypto';
import { logger } from '../logger';
import { TIER_CONFIG } from '../auth/rbac';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Graceful-degradation strategy when upstream systems are unavailable. */
export type GraceDegradationStrategy = 'drop' | 'queue' | 'fallback';

/**
 * Custom rate-limit configuration for a single enterprise organisation.
 */
export interface EnterpriseTierConfig {
  maxPerMinute: number;
  maxBurst: number;
  windowMs: number;
  label: string;
  featureFlags: string[];
  graceDegradation: GraceDegradationStrategy;
}

/** Pub/Sub invalidation message payload across API replicas. */
export interface EnterpriseTierInvalidationMessage {
  orgId?: string;
  senderId: string;
  timestamp: number;
  action?: 'upsert' | 'delete' | 'clear';
}

export interface InvalidationPublisher {
  publish(channel: string, message: string): Promise<number>;
}

export interface InvalidationSubscriber {
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
  unsubscribe(channel?: string): Promise<void>;
}

// ── Constants & State ─────────────────────────────────────────────────────────

export const ENTERPRISE_TIER_INVALIDATION_CHANNEL = '__enterprise_tier:invalidate';

/** Bounded propagation window target for cross-replica invalidations (sub-second). */
export const PROPAGATION_TARGET_MS = 500;

/** How long a cached entry stays valid before it is evicted on next read. */
export const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export const INSTANCE_ID = process.env.POD_NAME || process.env.HOSTNAME || randomUUID();

interface CacheEntry {
  config: EnterpriseTierConfig;
  expiresAt: number;
}

const tierCache = new Map<string, CacheEntry>();

let activePublisher: InvalidationPublisher | null = null;
let activeSubscriber: InvalidationSubscriber | null = null;

// ── Standard enterprise defaults ──────────────────────────────────────────────

export const ENTERPRISE_DEFAULTS: EnterpriseTierConfig = {
  maxPerMinute: TIER_CONFIG.enterprise.rateLimit.perMinute,
  maxBurst: TIER_CONFIG.enterprise.rateLimit.burst,
  windowMs: 60_000,
  label: 'enterprise',
  featureFlags: [],
  graceDegradation: 'fallback',
};

// ── Invalidation Hooks ────────────────────────────────────────────────────────

export function setInvalidationPublisher(publisher: InvalidationPublisher | null): void {
  activePublisher = publisher;
}

export function setInvalidationSubscriber(subscriber: InvalidationSubscriber | null): void {
  activeSubscriber = subscriber;
}

export function getInvalidationPublisher(): InvalidationPublisher | null {
  return activePublisher;
}

/**
 * Broadcast an invalidation signal to all other active API replicas.
 * Always purges the local in-memory cache immediately.
 *
 * If the channel is disconnected or unavailable, records a structured diagnostic
 * and returns false without breaking execution.
 */
export async function publishEnterpriseTierInvalidation(
  orgId?: string,
  publisher: InvalidationPublisher | null = activePublisher,
): Promise<boolean> {
  // Always evict locally first
  clearEnterpriseTierCache(orgId);

  if (!publisher) {
    logger.warn(
      '[enterprise-tier-cache] Invalidation publisher unavailable; cross-replica invalidation degraded. Replicas will recover on TTL expiry.',
      { orgId, alert: 'ENTERPRISE_TIER_INVALIDATION_DEGRADED' },
    );
    return false;
  }

  const payload: EnterpriseTierInvalidationMessage = {
    orgId,
    senderId: INSTANCE_ID,
    timestamp: Date.now(),
    action: orgId ? 'upsert' : 'clear',
  };

  try {
    await publisher.publish(ENTERPRISE_TIER_INVALIDATION_CHANNEL, JSON.stringify(payload));
    logger.debug('[enterprise-tier-cache] Cross-replica invalidation broadcasted', { orgId });
    return true;
  } catch (err) {
    logger.error(
      '[enterprise-tier-cache] Failed to broadcast cross-replica invalidation; replicas will recover on TTL expiry',
      { orgId, error: String(err), alert: 'ENTERPRISE_TIER_INVALIDATION_DEGRADED' },
    );
    return false;
  }
}

/**
 * Handle incoming cross-replica invalidation message.
 */
export function handleRemoteInvalidation(
  rawMessage: string,
  onInvalidate?: (orgId?: string) => void,
): void {
  try {
    let orgId: string | undefined;
    let senderId: string | undefined;

    if (rawMessage.startsWith('{')) {
      const parsed = JSON.parse(rawMessage) as EnterpriseTierInvalidationMessage;
      orgId = parsed.orgId;
      senderId = parsed.senderId;
    } else {
      orgId = rawMessage.trim() || undefined;
    }

    // Don't re-process messages from ourself if senderId is identified
    if (senderId && senderId === INSTANCE_ID) {
      return;
    }

    clearEnterpriseTierCache(orgId);
    if (onInvalidate) onInvalidate(orgId);

    logger.debug('[enterprise-tier-cache] Processed cross-replica invalidation', {
      orgId,
      senderId,
    });
  } catch (err) {
    // If malformed, clear entire cache defensively
    clearEnterpriseTierCache();
    logger.warn('[enterprise-tier-cache] Malformed invalidation message; cleared full cache', {
      error: String(err),
      rawMessage,
    });
  }
}

/**
 * Initialize subscriber on an invalidation listener.
 */
export async function setupEnterpriseTierSubscriber(
  subscriber: InvalidationSubscriber,
  onInvalidate?: (orgId?: string) => void,
): Promise<() => Promise<void>> {
  activeSubscriber = subscriber;

  await subscriber.subscribe(ENTERPRISE_TIER_INVALIDATION_CHANNEL, (message: string) => {
    handleRemoteInvalidation(message, onInvalidate);
  });

  logger.info('[enterprise-tier-cache] Cross-replica invalidation subscriber registered', {
    channel: ENTERPRISE_TIER_INVALIDATION_CHANNEL,
    boundMs: PROPAGATION_TARGET_MS,
  });

  return async () => {
    try {
      await subscriber.unsubscribe(ENTERPRISE_TIER_INVALIDATION_CHANNEL);
      if (activeSubscriber === subscriber) {
        activeSubscriber = null;
      }
    } catch (err) {
      logger.warn('[enterprise-tier-cache] Error unsubscribing from invalidation channel', {
        error: String(err),
      });
    }
  };
}

// ── Public Cache Accessors ────────────────────────────────────────────────────

/**
 * Retrieve the enterprise tier config for an organisation from the in-memory cache.
 * Returns `null` if no custom config has been registered for `orgId`.
 */
export async function getEnterpriseTierConfig(orgId: string): Promise<EnterpriseTierConfig | null> {
  if (!orgId) return null;

  const entry = tierCache.get(orgId);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    // Lazy TTL eviction
    tierCache.delete(orgId);
    logger.debug('[enterprise-tier-cache] TTL expired, entry evicted', { orgId });
    return null;
  }

  return entry.config;
}

/**
 * Store or overwrite the enterprise tier config for an organisation.
 * The entry is automatically evicted after `CACHE_TTL_MS` milliseconds.
 */
export function setEnterpriseTierConfig(orgId: string, config: EnterpriseTierConfig): void {
  if (!orgId) return;
  tierCache.set(orgId, { config, expiresAt: Date.now() + CACHE_TTL_MS });
  logger.debug('[enterprise-tier-cache] Config cached', { orgId, label: config.label });
}

/**
 * Evict one or all entries from the in-memory cache.
 */
export function clearEnterpriseTierCache(orgId?: string): void {
  if (orgId !== undefined) {
    tierCache.delete(orgId);
    logger.debug('[enterprise-tier-cache] Cache cleared for org', { orgId });
  } else {
    tierCache.clear();
    logger.debug('[enterprise-tier-cache] Full cache cleared');
  }
}

/**
 * Return the number of currently cached entries.
 */
export function getEnterpriseTierCacheSize(): number {
  return tierCache.size;
}
