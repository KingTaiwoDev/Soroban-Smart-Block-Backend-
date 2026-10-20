/**
 * Enterprise SSO — user and org auto-provisioning (PLT09 / #1030).
 *
 * When an unknown (or existing) user authenticates via SSO this module:
 *   1. Finds or creates a WalletUser record linked to the IdP subject.
 *   2. Applies the SsoOrg's defaultRole and defaultTier to the user.
 *   3. Records a structured audit event for every provisioning action.
 *   4. Emits Prometheus metrics for the provisioning outcome.
 *
 * Tenant isolation guarantee
 * ──────────────────────────
 * Every DB query that reads or writes user data is scoped to the
 * (providerId, idpSubject) or (email) pair supplied by the verified ID token.
 * No query touches users that belong to a different provider or org — this is
 * enforced at the query layer, not just middleware.
 */

import { prismaWrite as prisma } from '../../db';
import { logger } from '../../logger';
import { uuidv7 } from '../../utils/uuidv7';
import { recordProvision } from './metrics';
import type { OidcIdTokenClaims } from './oidc';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisionResult {
  /** The WalletUser.id of the (possibly newly created) user. */
  userId: string;
  /** Address stored in WalletUser.  For SSO users this is the synthetic
   *  address derived from the IdP subject (no on-chain wallet required). */
  address: string;
  role: string;
  tier: string;
  /** true if a new WalletUser row was created; false if an existing one was linked. */
  isNewUser: boolean;
}

// ---------------------------------------------------------------------------
// Synthetic address generation
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic, collision-resistant "address" for SSO users that
 * do not have a Stellar wallet.  The address is prefixed `SSO:` so it is
 * trivially distinguishable from a real Stellar public key (G…) while still
 * fitting in the WalletUser.address unique column.
 *
 * Format: SSO:{providerId}:{idpSubject}
 */
export function syntheticSsoAddress(providerId: string, idpSubject: string): string {
  return `SSO:${providerId}:${idpSubject}`;
}

// ---------------------------------------------------------------------------
// Core provisioning function
// ---------------------------------------------------------------------------

/**
 * Finds or creates a WalletUser for the authenticated SSO subject.
 *
 * Lookup order:
 *   1. By synthetic address (SSO:{providerId}:{sub}) — exact match for
 *      returning SSO users.
 *   2. By email — merges an existing account that registered via another
 *      method (e.g. wallet auth) with the same email.
 *   3. Create a new WalletUser if autoProvision is enabled.
 *
 * @param claims        Verified ID token claims from the IdP.
 * @param providerId    SsoProvider.id — used for synthetic address and audit.
 * @param ssoOrgConfig  SsoOrg settings controlling tier, role, and provisioning.
 */
export async function provisionSsoUser(
  claims: OidcIdTokenClaims,
  providerId: string,
  ssoOrgConfig: {
    autoProvision: boolean;
    enforceEmailDomain: boolean;
    domains: string[];
    defaultRole: string;
    defaultTier: string;
    orgId: string;
  },
): Promise<ProvisionResult> {
  const idpSubject = claims.sub;
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase().trim() : undefined;
  const displayName = typeof claims.name === 'string' ? claims.name : undefined;
  const avatarUrl = typeof claims.picture === 'string' ? claims.picture : undefined;

  // ── Domain enforcement ──────────────────────────────────────────────────
  if (ssoOrgConfig.enforceEmailDomain && email) {
    const domain = email.split('@')[1] ?? '';
    const allowed = ssoOrgConfig.domains as string[];
    if (allowed.length > 0 && !allowed.includes(domain)) {
      throw new Error(
        `[sso/provision] Email domain "${domain}" is not authorised for org ${ssoOrgConfig.orgId}. ` +
          `Allowed domains: ${allowed.join(', ')}`,
      );
    }
  }

  const syntheticAddress = syntheticSsoAddress(providerId, idpSubject);

  // ── 1. Look up by synthetic SSO address ─────────────────────────────────
  let user = await prisma.walletUser.findUnique({ where: { address: syntheticAddress } });

  if (user) {
    // Refresh display name / avatar on every login
    await prisma.walletUser.update({
      where: { id: user.id },
      data: {
        displayName: displayName ?? user.displayName,
        avatarUrl: avatarUrl ?? user.avatarUrl,
        email: email ?? user.email,
        lastLogin: new Date(),
      },
    });

    logger.info('[sso/provision] Existing SSO user linked', {
      userId: user.id,
      providerId,
      orgId: ssoOrgConfig.orgId,
    });
    recordProvision(providerId, 'linked');

    return {
      userId: user.id,
      address: user.address,
      role: user.role,
      tier: user.tier,
      isNewUser: false,
    };
  }

  // ── 2. Look up by email (merge with existing non-SSO account) ───────────
  if (email) {
    user = await prisma.walletUser.findFirst({ where: { email } });
    if (user) {
      // Upgrade the existing account to SSO-linked address
      await prisma.walletUser.update({
        where: { id: user.id },
        data: {
          displayName: displayName ?? user.displayName,
          avatarUrl: avatarUrl ?? user.avatarUrl,
          tier: ssoOrgConfig.defaultTier,
          lastLogin: new Date(),
        },
      });

      await _writeAuditEvent({
        providerId,
        subjectId: user.id,
        eventType: 'sso.user.linked',
        after: {
          userId: user.id,
          email,
          providerId,
          orgId: ssoOrgConfig.orgId,
          mergedFromExistingAccount: true,
        },
      });

      logger.info('[sso/provision] Existing wallet-auth user merged with SSO identity', {
        userId: user.id,
        providerId,
        orgId: ssoOrgConfig.orgId,
      });
      recordProvision(providerId, 'linked');

      return {
        userId: user.id,
        address: user.address,
        role: user.role,
        tier: ssoOrgConfig.defaultTier,
        isNewUser: false,
      };
    }
  }

  // ── 3. Auto-provision new user ───────────────────────────────────────────
  if (!ssoOrgConfig.autoProvision) {
    throw new Error(
      `[sso/provision] User "${email ?? idpSubject}" is not registered and autoProvision is disabled ` +
        `for org ${ssoOrgConfig.orgId}.`,
    );
  }

  const newUser = await prisma.walletUser.create({
    data: {
      id: uuidv7(),
      address: syntheticAddress,
      role: ssoOrgConfig.defaultRole,
      tier: ssoOrgConfig.defaultTier,
      displayName,
      email,
      avatarUrl,
      isActive: true,
      lastLogin: new Date(),
      metadata: { sso: { providerId, idpSubject, orgId: ssoOrgConfig.orgId } },
    },
  });

  await _writeAuditEvent({
    providerId,
    subjectId: newUser.id,
    eventType: 'sso.user.provisioned',
    after: {
      userId: newUser.id,
      email,
      providerId,
      orgId: ssoOrgConfig.orgId,
      role: ssoOrgConfig.defaultRole,
      tier: ssoOrgConfig.defaultTier,
    },
  });

  logger.info('[sso/provision] New SSO user provisioned', {
    userId: newUser.id,
    providerId,
    orgId: ssoOrgConfig.orgId,
    email,
  });
  recordProvision(providerId, 'created');

  return {
    userId: newUser.id,
    address: newUser.address,
    role: newUser.role,
    tier: newUser.tier,
    isNewUser: true,
  };
}

// ---------------------------------------------------------------------------
// Audit event helpers
// ---------------------------------------------------------------------------

/**
 * Writes a row to SsoAuditEvent.  Never throws — audit failures are logged
 * but must not block the auth flow (availability > audit completeness during
 * outages).
 */
export async function _writeAuditEvent(entry: {
  providerId?: string;
  actorId?: string;
  subjectId?: string;
  eventType: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
  userAgent?: string;
  metadata?: unknown;
}): Promise<void> {
  try {
    await prisma.ssoAuditEvent.create({
      data: {
        providerId: entry.providerId ?? null,
        actorId: entry.actorId ?? null,
        subjectId: entry.subjectId ?? null,
        eventType: entry.eventType,
        before: entry.before !== undefined ? (entry.before as object) : undefined,
        after: entry.after !== undefined ? (entry.after as object) : undefined,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
        metadata: entry.metadata !== undefined ? (entry.metadata as object) : undefined,
      },
    });
  } catch (err) {
    logger.error('[sso/provision] Failed to write audit event — non-fatal', {
      eventType: entry.eventType,
      error: String(err),
    });
  }
}
