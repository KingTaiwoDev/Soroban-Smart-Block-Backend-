import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setEnterpriseTierConfig,
  getEnterpriseTierConfig,
  clearEnterpriseTierCache,
  publishEnterpriseTierInvalidation,
  setupEnterpriseTierSubscriber,
  handleRemoteInvalidation,
  ENTERPRISE_TIER_INVALIDATION_CHANNEL,
  PROPAGATION_TARGET_MS,
  INSTANCE_ID,
  type EnterpriseTierConfig,
  type InvalidationPublisher,
  type InvalidationSubscriber,
} from '../src/middleware/enterpriseTierCache';

vi.mock('../src/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../src/logger';

function sampleTier(orgId: string, limit = 50000): EnterpriseTierConfig {
  return {
    maxPerMinute: limit,
    maxBurst: 5000,
    windowMs: 60000,
    label: `${orgId}-gold`,
    featureFlags: ['bulk_export'],
    graceDegradation: 'fallback',
  };
}

describe('Issue #1284: Cross-replica enterprise tier cache invalidation', () => {
  beforeEach(() => {
    clearEnterpriseTierCache();
    vi.clearAllMocks();
  });

  describe('Bounded cross-replica propagation', () => {
    it('invalidates remote cache instance when invalidation message is received', async () => {
      const orgId = 'org_alpha';
      const config1 = sampleTier(orgId, 50000);
      setEnterpriseTierConfig(orgId, config1);

      // Verify cached initially
      expect(await getEnterpriseTierConfig(orgId)).toEqual(config1);

      // Simulate remote replica invalidation message
      const remoteMessage = JSON.stringify({
        orgId,
        senderId: 'pod-replica-2',
        timestamp: Date.now(),
        action: 'upsert',
      });

      handleRemoteInvalidation(remoteMessage);

      // Cache should now be cleared locally
      expect(await getEnterpriseTierConfig(orgId)).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        '[enterprise-tier-cache] Processed cross-replica invalidation',
        expect.objectContaining({ orgId, senderId: 'pod-replica-2' }),
      );
    });

    it('ignores self-broadcast invalidation messages to avoid redundant work', async () => {
      const orgId = 'org_bravo';
      const config = sampleTier(orgId, 60000);
      setEnterpriseTierConfig(orgId, config);

      const selfMessage = JSON.stringify({
        orgId,
        senderId: INSTANCE_ID,
        timestamp: Date.now(),
      });

      handleRemoteInvalidation(selfMessage);

      // Should still be present since it came from ourselves
      expect(await getEnterpriseTierConfig(orgId)).toEqual(config);
    });

    it('clears all cached entries when receiving wildcard or empty org invalidation', async () => {
      setEnterpriseTierConfig('org_1', sampleTier('org_1'));
      setEnterpriseTierConfig('org_2', sampleTier('org_2'));

      const remoteClearAll = JSON.stringify({
        senderId: 'pod-replica-admin',
        timestamp: Date.now(),
        action: 'clear',
      });

      handleRemoteInvalidation(remoteClearAll);

      expect(await getEnterpriseTierConfig('org_1')).toBeNull();
      expect(await getEnterpriseTierConfig('org_2')).toBeNull();
    });

    it('propagates invalidation through publisher and subscriber pipeline', async () => {
      let channelListener: ((msg: string, ch: string) => void) | null = null;

      const mockPublisher: InvalidationPublisher = {
        publish: vi.fn(async (ch: string, msg: string) => {
          if (channelListener) {
            channelListener(msg, ch);
          }
          return 1;
        }),
      };

      const mockSubscriber: InvalidationSubscriber = {
        subscribe: vi.fn(async (_ch: string, listener) => {
          channelListener = listener;
        }),
        unsubscribe: vi.fn(async () => {
          channelListener = null;
        }),
      };

      const teardown = await setupEnterpriseTierSubscriber(mockSubscriber);
      expect(mockSubscriber.subscribe).toHaveBeenCalledWith(
        ENTERPRISE_TIER_INVALIDATION_CHANNEL,
        expect.any(Function),
      );

      // Populate local cache
      setEnterpriseTierConfig('org_echo', sampleTier('org_echo'));
      expect(await getEnterpriseTierConfig('org_echo')).not.toBeNull();

      // Trigger publish (simulating external pod sender)
      const externalSenderPayload = JSON.stringify({
        orgId: 'org_echo',
        senderId: 'different-pod-uuid',
        timestamp: Date.now(),
      });
      channelListener!(externalSenderPayload, ENTERPRISE_TIER_INVALIDATION_CHANNEL);

      // Assert cache was evicted on subscriber side
      expect(await getEnterpriseTierConfig('org_echo')).toBeNull();

      await teardown();
      expect(mockSubscriber.unsubscribe).toHaveBeenCalledWith(
        ENTERPRISE_TIER_INVALIDATION_CHANNEL,
      );
    });
  });

  describe('Degradation, diagnostic alerts, and TTL recovery', () => {
    it('emits observable diagnostic when publisher is unavailable and falls back safely', async () => {
      const orgId = 'org_charlie';
      setEnterpriseTierConfig(orgId, sampleTier(orgId));

      // Publish with null publisher
      const published = await publishEnterpriseTierInvalidation(orgId, null);

      expect(published).toBe(false);
      // Local cache is still evicted
      expect(await getEnterpriseTierConfig(orgId)).toBeNull();

      // Diagnostic alert emitted
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalidation publisher unavailable'),
        expect.objectContaining({
          orgId,
          alert: 'ENTERPRISE_TIER_INVALIDATION_DEGRADED',
        }),
      );
    });

    it('emits observable diagnostic when publisher throws an error', async () => {
      const orgId = 'org_delta';
      setEnterpriseTierConfig(orgId, sampleTier(orgId));

      const failingPublisher: InvalidationPublisher = {
        publish: vi.fn().mockRejectedValue(new Error('Redis connection refused: 6379')),
      };

      const published = await publishEnterpriseTierInvalidation(orgId, failingPublisher);

      expect(published).toBe(false);
      expect(await getEnterpriseTierConfig(orgId)).toBeNull();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to broadcast cross-replica invalidation'),
        expect.objectContaining({
          orgId,
          alert: 'ENTERPRISE_TIER_INVALIDATION_DEGRADED',
          error: expect.stringContaining('Redis connection refused'),
        }),
      );
    });

    it('recovers gracefully by TTL expiry when cross-replica invalidation is missed', async () => {
      const orgId = 'org_missed_update';
      const oldConfig = sampleTier(orgId, 10000);

      // Simulate a cached entry on Replica B
      setEnterpriseTierConfig(orgId, oldConfig);
      expect(await getEnterpriseTierConfig(orgId)).toEqual(oldConfig);

      // Fast-forward time past 5-minute CACHE_TTL_MS (300,001 ms)
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);

      // On next read, lazy TTL eviction purges stale config
      const postTtlConfig = await getEnterpriseTierConfig(orgId);
      expect(postTtlConfig).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('TTL expired, entry evicted'),
        { orgId },
      );
    });

    it('handles malformed JSON payloads gracefully by clearing cache defensively', () => {
      setEnterpriseTierConfig('org_safe', sampleTier('org_safe'));

      handleRemoteInvalidation('{ bad json !!');

      // Full cache is defensively cleared on malformed payload
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Malformed invalidation message; cleared full cache'),
        expect.any(Object),
      );
    });
  });

  describe('Non-hard Redis dependency', () => {
    it('operates completely in-memory with zero Redis dependency', async () => {
      const org = 'org_standalone';
      const tier = sampleTier(org, 25000);

      setEnterpriseTierConfig(org, tier);
      expect(await getEnterpriseTierConfig(org)).toEqual(tier);

      clearEnterpriseTierCache(org);
      expect(await getEnterpriseTierConfig(org)).toBeNull();
    });
  });
});
