/**
 * Organizations & team management (PLT01 / #1022).
 *
 * Organizations own API keys, quotas, and billing details and have multiple
 * member seats with roles. All routes require an API key; the acting user is
 * the key's developer.
 *
 *   POST   /api/v1/orgs                               — create org (caller becomes owner)
 *   GET    /api/v1/orgs                               — orgs the caller belongs to
 *   GET    /api/v1/orgs/:orgId                        — org details (member+)
 *   PATCH  /api/v1/orgs/:orgId                        — update name/quota/billing (admin+)
 *   POST   /api/v1/orgs/:orgId/members                — add member (admin+)
 *   PATCH  /api/v1/orgs/:orgId/members/:developerId   — change role (admin+; owner role: owner)
 *   DELETE /api/v1/orgs/:orgId/members/:developerId   — remove member (admin+, or self)
 *   POST   /api/v1/orgs/:orgId/keys                   — scope the calling key to the org (admin+)
 *   POST   /api/v1/orgs/:orgId/keys/:keyId/transfer   — move a key to another org (admin+ in both)
 *   GET    /api/v1/orgs/:orgId/audit                  — audit log (admin+)
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { recordAdminAudit } from '../lib/admin-audit';

export type OrgRole = 'owner' | 'admin' | 'billing' | 'member';

const ROLE_RANK: Record<OrgRole, number> = { member: 0, billing: 1, admin: 2, owner: 3 };

export interface Organization {
  id: string;
  name: string;
  members: Record<string, OrgRole>;
  keyIds: string[];
  quota: { monthlyRequests: number };
  billing: { email?: string; plan: 'free' | 'team' | 'enterprise' };
  createdAt: string;
}

export interface OrgAuditEntry {
  at: string;
  actor: string;
  action: string;
  details: Record<string, unknown>;
}

const orgs = new Map<string, Organization>();
const keyOwner = new Map<string, string>(); // keyId → orgId
const audit = new Map<string, OrgAuditEntry[]>();

/** Test helper — clears all in-memory organization state. */
export function resetOrganizations(): void {
  orgs.clear();
  keyOwner.clear();
  audit.clear();
}

/** Returns the organization that owns an API key, if any. */
export function getOrgForKey(keyId: string): Organization | undefined {
  const orgId = keyOwner.get(keyId);
  return orgId ? orgs.get(orgId) : undefined;
}

function record(
  orgId: string,
  actor: string,
  action: string,
  details: Record<string, unknown> = {},
): void {
  const log = audit.get(orgId) ?? [];
  log.push({ at: new Date().toISOString(), actor, action, details });
  if (log.length > 1_000) log.shift();
  audit.set(orgId, log);
  // The in-memory log above backs GET /:orgId/audit; also persist to the
  // durable audit table so membership/role/key changes survive restarts (#1232).
  void recordAdminAudit({
    actor,
    action: action.startsWith('org.') ? action : `org.${action}`,
    target: orgId,
    newState: details,
  });
}

function actorOf(req: Request): string | undefined {
  return req.apiKey?.developerId;
}

/** Resolve org + enforce minimum role; sends the error response and returns null on failure. */
function authorize(req: Request, res: Response, orgId: string, min: OrgRole): Organization | null {
  const actor = actorOf(req);
  if (!actor) {
    res.status(401).json({ error: 'API key required' });
    return null;
  }
  const org = orgs.get(orgId);
  const role = org?.members[actor];
  if (!org || !role) {
    res.status(404).json({ error: 'Organization not found' });
    return null;
  }
  if (ROLE_RANK[role] < ROLE_RANK[min]) {
    res.status(403).json({ error: `Requires ${min} role` });
    return null;
  }
  return org;
}

const role = z.enum(['owner', 'admin', 'billing', 'member']);
const developerId = z.string().min(1).max(128);
const CreateSchema = z.object({ name: z.string().trim().min(2).max(100) });
const UpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  quota: z.object({ monthlyRequests: z.number().int().min(0).max(1e10) }).optional(),
  billing: z
    .object({
      email: z.string().email().max(254).optional(),
      plan: z.enum(['free', 'team', 'enterprise']),
    })
    .optional(),
});

export const organizationsRouter = Router();

organizationsRouter.post('/', (req: Request, res: Response) => {
  const actor = actorOf(req);
  if (!actor) return res.status(401).json({ error: 'API key required' });
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const org: Organization = {
    id: randomUUID(),
    name: parsed.data.name,
    members: { [actor]: 'owner' },
    keyIds: [],
    quota: { monthlyRequests: 100_000 },
    billing: { plan: 'free' },
    createdAt: new Date().toISOString(),
  };
  orgs.set(org.id, org);
  record(org.id, actor, 'org.created', { name: org.name });
  res.status(201).json(org);
});

organizationsRouter.get('/', (req: Request, res: Response) => {
  const actor = actorOf(req);
  if (!actor) return res.status(401).json({ error: 'API key required' });
  const list = [...orgs.values()].filter((o) => o.members[actor]);
  res.json({ organizations: list, total: list.length });
});

organizationsRouter.get('/:orgId', (req: Request, res: Response) => {
  const org = authorize(req, res, req.params.orgId, 'member');
  if (org) res.json(org);
});

organizationsRouter.patch('/:orgId', (req: Request, res: Response) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  // Billing changes may be made by billing role; everything else needs admin.
  const onlyBilling = !parsed.data.name && !parsed.data.quota;
  const org = authorize(req, res, req.params.orgId, onlyBilling ? 'billing' : 'admin');
  if (!org) return;
  Object.assign(org, parsed.data);
  record(org.id, actorOf(req)!, 'org.updated', parsed.data);
  res.json(org);
});

organizationsRouter.post('/:orgId/members', (req: Request, res: Response) => {
  const parsed = z.object({ developerId, role: role.default('member') }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const minRole: OrgRole = parsed.data.role === 'owner' ? 'owner' : 'admin';
  const org = authorize(req, res, req.params.orgId, minRole);
  if (!org) return;
  if (org.members[parsed.data.developerId]) {
    return res.status(409).json({ error: 'Already a member' });
  }
  org.members[parsed.data.developerId] = parsed.data.role;
  record(org.id, actorOf(req)!, 'member.added', parsed.data);
  res.status(201).json({ members: org.members });
});

organizationsRouter.patch('/:orgId/members/:developerId', (req: Request, res: Response) => {
  const parsed = z.object({ role }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const target = req.params.developerId;
  const current = orgs.get(req.params.orgId)?.members[target];
  const needsOwner = parsed.data.role === 'owner' || current === 'owner';
  const org = authorize(req, res, req.params.orgId, needsOwner ? 'owner' : 'admin');
  if (!org) return;
  if (!current) return res.status(404).json({ error: 'Member not found' });
  const owners = Object.values(org.members).filter((r) => r === 'owner').length;
  if (current === 'owner' && parsed.data.role !== 'owner' && owners === 1) {
    return res.status(409).json({ error: 'Organization must keep at least one owner' });
  }
  org.members[target] = parsed.data.role;
  record(org.id, actorOf(req)!, 'member.role_changed', {
    developerId: target,
    from: current,
    to: parsed.data.role,
  });
  res.json({ members: org.members });
});

organizationsRouter.delete('/:orgId/members/:developerId', (req: Request, res: Response) => {
  const target = req.params.developerId;
  const self = target === actorOf(req);
  const current = orgs.get(req.params.orgId)?.members[target];
  const minRole: OrgRole = self ? 'member' : current === 'owner' ? 'owner' : 'admin';
  const org = authorize(req, res, req.params.orgId, minRole);
  if (!org) return;
  if (!current) return res.status(404).json({ error: 'Member not found' });
  const owners = Object.values(org.members).filter((r) => r === 'owner').length;
  if (current === 'owner' && owners === 1) {
    return res.status(409).json({ error: 'Organization must keep at least one owner' });
  }
  delete org.members[target];
  record(org.id, actorOf(req)!, 'member.removed', { developerId: target });
  res.status(204).end();
});

organizationsRouter.post('/:orgId/keys', (req: Request, res: Response) => {
  const org = authorize(req, res, req.params.orgId, 'admin');
  if (!org) return;
  const keyId = req.apiKey!.id;
  if (keyOwner.has(keyId)) {
    return res.status(409).json({ error: 'Key already belongs to an organization; use transfer' });
  }
  keyOwner.set(keyId, org.id);
  org.keyIds.push(keyId);
  record(org.id, actorOf(req)!, 'key.scoped', { keyId });
  res.status(201).json({ keyId, orgId: org.id });
});

organizationsRouter.post('/:orgId/keys/:keyId/transfer', (req: Request, res: Response) => {
  const parsed = z.object({ targetOrgId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const source = authorize(req, res, req.params.orgId, 'admin');
  if (!source) return;
  const keyId = req.params.keyId;
  if (keyOwner.get(keyId) !== source.id) {
    return res.status(404).json({ error: 'Key not found in organization' });
  }
  const target = authorize(req, res, parsed.data.targetOrgId, 'admin');
  if (!target) return;
  source.keyIds = source.keyIds.filter((k) => k !== keyId);
  target.keyIds.push(keyId);
  keyOwner.set(keyId, target.id);
  const actor = actorOf(req)!;
  record(source.id, actor, 'key.transferred_out', { keyId, to: target.id });
  record(target.id, actor, 'key.transferred_in', { keyId, from: source.id });
  res.json({ keyId, orgId: target.id });
});

organizationsRouter.get('/:orgId/audit', (req: Request, res: Response) => {
  const org = authorize(req, res, req.params.orgId, 'admin');
  if (org) res.json({ entries: audit.get(org.id) ?? [] });
});
