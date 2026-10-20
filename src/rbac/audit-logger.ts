/**
 * RBAC Audit Logging System
 *
 * Comprehensive audit logging for all RBAC operations, permission checks,
 * and sensitive actions with tamper-evident storage and compliance features.
 */

import crypto from 'crypto';
import { prismaWrite, prismaRead } from '../db';
import { logger } from '../logger';
import { background } from '../utils/background';
import { AuthPrincipal, ResourceContext } from './types';
import {
  AUDIT_INTEGRITY_VERSION,
  computeAuditRecordChecksum,
} from './audit-integrity';

/**
 * Audit event types for RBAC operations
 */
export enum AuditEventType {
  // Authentication events
  LOGIN_SUCCESS = 'auth.login.success',
  LOGIN_FAILURE = 'auth.login.failure',
  LOGOUT = 'auth.logout',
  SESSION_EXPIRED = 'auth.session.expired',
  SESSION_REVOKED = 'auth.session.revoked',
  
  // Permission events
  PERMISSION_GRANTED = 'rbac.permission.granted',
  PERMISSION_DENIED = 'rbac.permission.denied',
  PERMISSION_CHECK = 'rbac.permission.check',
  
  // Role events
  ROLE_ASSIGNED = 'rbac.role.assigned',
  ROLE_REVOKED = 'rbac.role.revoked',
  ROLE_CREATED = 'rbac.role.created',
  ROLE_UPDATED = 'rbac.role.updated',
  ROLE_DELETED = 'rbac.role.deleted',
  
  // Permission management events
  PERMISSION_CREATED = 'rbac.permission.created',
  PERMISSION_UPDATED = 'rbac.permission.updated',
  PERMISSION_DELETED = 'rbac.permission.deleted',
  DIRECT_PERMISSION_GRANTED = 'rbac.direct_permission.granted',
  DIRECT_PERMISSION_REVOKED = 'rbac.direct_permission.revoked',
  
  // Tenant events
  TENANT_CREATED = 'tenant.created',
  TENANT_UPDATED = 'tenant.updated',
  TENANT_DELETED = 'tenant.deleted',
  TENANT_ACCESS_GRANTED = 'tenant.access.granted',
  TENANT_ACCESS_DENIED = 'tenant.access.denied',
  
  // API Key events
  API_KEY_CREATED = 'api_key.created',
  API_KEY_REVOKED = 'api_key.revoked',
  API_KEY_USED = 'api_key.used',
  API_KEY_SCOPE_UPDATED = 'api_key.scope.updated',
  
  // Administrative events
  ADMIN_ACTION = 'admin.action',
  SYSTEM_CONFIG_CHANGED = 'system.config.changed',
  CACHE_CLEARED = 'system.cache.cleared',
  
  // Security events
  SECURITY_VIOLATION = 'security.violation',
  SUSPICIOUS_ACTIVITY = 'security.suspicious',
  RATE_LIMIT_EXCEEDED = 'security.rate_limit',
  IP_BLOCKED = 'security.ip_blocked',
  
  // Compliance events
  COMPLIANCE_SCREEN = 'compliance.screen',
  FREEZE_APPLIED = 'compliance.freeze.applied',
  FREEZE_REMOVED = 'compliance.freeze.removed',
  SENSITIVE_DATA_ACCESS = 'compliance.sensitive_access',
  
  // Data events
  DATA_EXPORT = 'data.export',
  DATA_IMPORT = 'data.import',
  DATA_DELETION = 'data.deletion',
  BULK_OPERATION = 'data.bulk_operation',
}

/**
 * Severity levels for audit events
 */
export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

/**
 * Audit event structure
 */
export interface AuditEvent {
  id?: string;
  type: AuditEventType;
  severity: AuditSeverity;
  actor: string; // User ID, API key ID, or 'system'
  actorType: 'user' | 'api_key' | 'admin' | 'system';
  target?: string; // Resource or object being acted upon
  targetType?: string; // Type of target (user, role, permission, etc.)
  action: string; // Human-readable description
  
  // Request context
  requestId?: string;
  sessionId?: string;
  tenantId?: string;
  ipAddress?: string;
  userAgent?: string;
  
  // Event details
  details: Record<string, any>; // Event-specific data
  previousState?: Record<string, any>; // Before state for changes
  newState?: Record<string, any>; // After state for changes
  reason?: string; // Reason for the action
  
  // Metadata
  timestamp: Date;
  source: string; // Module or component that generated the event
  tags?: string[]; // Tags for categorization
  
  // Tamper evidence
  checksum?: string; // SHA-256 hash of event content
  previousChecksum?: string; // Hash of previous event for chaining
}

/**
 * Audit logging configuration
 */
export interface AuditConfig {
  enabled: boolean;
  logToDatabase: boolean;
  logToFile: boolean;
  logToConsole: boolean;
  batchSize: number;
  flushInterval: number; // milliseconds
  retentionDays: number;
  encryptSensitiveData: boolean;
  requireIntegrity: boolean; // Enable tamper-evident logging
  sensitiveFields: string[]; // Fields to encrypt
}

/**
 * Main audit logger class
 */
export class RbacAuditLogger {
  private config: AuditConfig;
  private eventQueue: AuditEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private lastEventChecksum?: string;
  private isFlushingToDatabase = false;

  constructor(config?: Partial<AuditConfig>) {
    this.config = {
      enabled: true,
      logToDatabase: true,
      logToFile: false,
      logToConsole: process.env.NODE_ENV === 'development',
      batchSize: 100,
      flushInterval: 5000, // 5 seconds
      retentionDays: 2555, // ~7 years for compliance
      encryptSensitiveData: true,
      requireIntegrity: true,
      sensitiveFields: ['email', 'address', 'phone', 'ssn', 'passport'],
      ...config,
    };

    if (this.config.enabled) {
      this.startFlushTimer();
      this.loadLastChecksum();
    }
  }

  /**
   * Log a permission check event
   */
  async logPermissionCheck(
    principal: AuthPrincipal,
    permission: string,
    allowed: boolean,
    context?: {
      resource?: ResourceContext;
      reason?: string;
      evaluationTime?: number;
      cacheHit?: boolean;
      requestId?: string;
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<void> {
    const event: AuditEvent = {
      type: allowed ? AuditEventType.PERMISSION_GRANTED : AuditEventType.PERMISSION_DENIED,
      severity: allowed ? AuditSeverity.INFO : AuditSeverity.WARNING,
      actor: principal.userId || principal.apiKeyId || 'anonymous',
      actorType: principal.type,
      target: permission,
      targetType: 'permission',
      action: `Permission ${permission} ${allowed ? 'granted' : 'denied'}`,
      requestId: context?.requestId,
      sessionId: principal.sessionId,
      tenantId: principal.tenantId || context?.resource?.tenantId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      details: {
        permission,
        allowed,
        resource: context?.resource,
        evaluationTime: context?.evaluationTime,
        cacheHit: context?.cacheHit,
      },
      reason: context?.reason,
      timestamp: new Date(),
      source: 'rbac.permission-engine',
      tags: ['permission-check', allowed ? 'granted' : 'denied'],
    };

    await this.logEvent(event);
  }

  /**
   * Log a role assignment event
   */
  async logRoleAssignment(
    actor: AuthPrincipal,
    targetUserId: string,
    roleId: string,
    tenantId?: string,
    context?: {
      expiresAt?: Date;
      reason?: string;
      requestId?: string;
    }
  ): Promise<void> {
    const event: AuditEvent = {
      type: AuditEventType.ROLE_ASSIGNED,
      severity: AuditSeverity.INFO,
      actor: actor.userId || actor.apiKeyId || 'system',
      actorType: actor.type,
      target: targetUserId,
      targetType: 'user',
      action: `Role ${roleId} assigned to user ${targetUserId}`,
      requestId: context?.requestId,
      sessionId: actor.sessionId,
      tenantId,
      details: {
        roleId,
        targetUserId,
        expiresAt: context?.expiresAt,
      },
      reason: context?.reason,
      timestamp: new Date(),
      source: 'rbac.service',
      tags: ['role-assignment'],
    };

    await this.logEvent(event);
  }

  /**
   * Log a role revocation event
   */
  async logRoleRevocation(
    actor: AuthPrincipal,
    targetUserId: string,
    roleId: string,
    tenantId?: string,
    context?: {
      reason?: string;
      requestId?: string;
    }
  ): Promise<void> {
    const event: AuditEvent = {
      type: AuditEventType.ROLE_REVOKED,
      severity: AuditSeverity.INFO,
      actor: actor.userId || actor.apiKeyId || 'system',
      actorType: actor.type,
      target: targetUserId,
      targetType: 'user',
      action: `Role ${roleId} revoked from user ${targetUserId}`,
      requestId: context?.requestId,
      sessionId: actor.sessionId,
      tenantId,
      details: {
        roleId,
        targetUserId,
      },
      reason: context?.reason,
      timestamp: new Date(),
      source: 'rbac.service',
      tags: ['role-revocation'],
    };

    await this.logEvent(event);
  }

  /**
   * Log a security violation
   */
  async logSecurityViolation(
    violationType: string,
    principal?: AuthPrincipal,
    context?: {
      description?: string;
      severity?: AuditSeverity;
      ipAddress?: string;
      userAgent?: string;
      requestId?: string;
      details?: Record<string, any>;
    }
  ): Promise<void> {
    const event: AuditEvent = {
      type: AuditEventType.SECURITY_VIOLATION,
      severity: context?.severity || AuditSeverity.ERROR,
      actor: principal?.userId || principal?.apiKeyId || 'anonymous',
      actorType: principal?.type || 'system',
      target: violationType,
      targetType: 'security',
      action: `Security violation: ${violationType}`,
      requestId: context?.requestId,
      sessionId: principal?.sessionId,
      tenantId: principal?.tenantId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      details: {
        violationType,
        ...context?.details,
      },
      reason: context?.description,
      timestamp: new Date(),
      source: 'rbac.security',
      tags: ['security-violation', violationType.toLowerCase().replace(/\s+/g, '-')],
    };

    await this.logEvent(event);
  }

  /**
   * Log a tenant access event
   */
  async logTenantAccess(
    principal: AuthPrincipal,
    targetTenantId: string,
    allowed: boolean,
    context?: {
      reason?: string;
      requestId?: string;
      ipAddress?: string;
    }
  ): Promise<void> {
    const event: AuditEvent = {
      type: allowed ? AuditEventType.TENANT_ACCESS_GRANTED : AuditEventType.TENANT_ACCESS_DENIED,
      severity: allowed ? AuditSeverity.INFO : AuditSeverity.WARNING,
      actor: principal.userId || principal.apiKeyId || 'anonymous',
      actorType: principal.type,
      target: targetTenantId,
      targetType: 'tenant',
      action: `Tenant access ${allowed ? 'granted' : 'denied'} for ${targetTenantId}`,
      requestId: context?.requestId,
      sessionId: principal.sessionId,
      tenantId: targetTenantId,
      ipAddress: context?.ipAddress,
      details: {
        allowed,
        targetTenantId,
        principalTenantId: principal.tenantId,
      },
      reason: context?.reason,
      timestamp: new Date(),
      source: 'rbac.tenant-isolation',
      tags: ['tenant-access', allowed ? 'granted' : 'denied'],
    };

    await this.logEvent(event);
  }

  /**
   * Log administrative actions
   */
  async logAdminAction(
    actor: AuthPrincipal,
    action: string,
    target?: string,
    context?: {
      targetType?: string;
      previousState?: Record<string, any>;
      newState?: Record<string, any>;
      reason?: string;
      requestId?: string;
      details?: Record<string, any>;
    }
  ): Promise<void> {
    const event: AuditEvent = {
      type: AuditEventType.ADMIN_ACTION,
      severity: AuditSeverity.INFO,
      actor: actor.userId || actor.apiKeyId || 'admin',
      actorType: actor.type,
      target,
      targetType: context?.targetType,
      action,
      requestId: context?.requestId,
      sessionId: actor.sessionId,
      tenantId: actor.tenantId,
      details: context?.details || {},
      previousState: context?.previousState,
      newState: context?.newState,
      reason: context?.reason,
      timestamp: new Date(),
      source: 'rbac.admin',
      tags: ['admin-action'],
    };

    await this.logEvent(event);
  }

  /**
   * Log sensitive data access
   */
  async logSensitiveAccess(
    principal: AuthPrincipal,
    dataType: string,
    target: string,
    context?: {
      endpoint?: string;
      method?: string;
      requestId?: string;
      ipAddress?: string;
      reason?: string;
    }
  ): Promise<void> {
    const event: AuditEvent = {
      type: AuditEventType.SENSITIVE_DATA_ACCESS,
      severity: AuditSeverity.INFO,
      actor: principal.userId || principal.apiKeyId || 'system',
      actorType: principal.type,
      target,
      targetType: dataType,
      action: `Sensitive ${dataType} accessed: ${target}`,
      requestId: context?.requestId,
      sessionId: principal.sessionId,
      tenantId: principal.tenantId,
      ipAddress: context?.ipAddress,
      details: {
        dataType,
        endpoint: context?.endpoint,
        method: context?.method,
      },
      reason: context?.reason,
      timestamp: new Date(),
      source: 'rbac.sensitive-access',
      tags: ['sensitive-access', dataType.toLowerCase()],
    };

    await this.logEvent(event);
  }

  /**
   * Generic event logging method
   */
  async logEvent(event: AuditEvent): Promise<void> {
    if (!this.config.enabled) return;

    try {
      // Generate event ID if not provided
      if (!event.id) {
        event.id = crypto.randomUUID();
      }

      // Encrypt sensitive fields if configured
      if (this.config.encryptSensitiveData) {
        event = this.encryptSensitiveFields(event);
      }

      // Add tamper-evident checksum if required
      if (this.config.requireIntegrity) {
        event = this.addIntegrityCheck(event);
      }

      // Add to queue for batch processing
      this.eventQueue.push(event);

      // Console logging for development
      if (this.config.logToConsole) {
        logger.info('RBAC Audit Event', {
          type: event.type,
          actor: event.actor,
          action: event.action,
          target: event.target,
          severity: event.severity,
          timestamp: event.timestamp,
        });
      }

      // Flush if queue is full
      if (this.eventQueue.length >= this.config.batchSize) {
        await this.flush();
      }
    } catch (error) {
      logger.error('Failed to log audit event', {
        error: error.message,
        event: { ...event, details: '[REDACTED]' },
      });
    }
  }

  /**
   * Query audit logs with filtering
   */
  async queryLogs(filters: {
    type?: AuditEventType | AuditEventType[];
    actor?: string;
    target?: string;
    tenantId?: string;
    startDate?: Date;
    endDate?: Date;
    severity?: AuditSeverity | AuditSeverity[];
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<{
    events: AuditEvent[];
    total: number;
  }> {
    const where: any = {};

    if (filters.type) {
      where.action = Array.isArray(filters.type) 
        ? { in: filters.type }
        : filters.type;
    }

    if (filters.actor) {
      where.actor = filters.actor;
    }

    if (filters.target) {
      where.target = filters.target;
    }

    if (filters.tenantId) {
      // For tenant-aware audit logs, this would filter by tenant context
      where.newState = {
        path: ['tenantId'],
        equals: filters.tenantId,
      };
    }

    if (filters.startDate || filters.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = filters.startDate;
      if (filters.endDate) where.createdAt.lte = filters.endDate;
    }

    const [events, total] = await Promise.all([
      prismaRead.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: filters.offset || 0,
        take: filters.limit || 100,
      }),
      prismaRead.auditLog.count({ where }),
    ]);

    // Convert database records to AuditEvent format
    const auditEvents = events.map(event => ({
      id: event.id,
      type: event.action as AuditEventType,
      severity: this.determineSeverity(event.action),
      actor: event.actor,
      actorType: this.determineActorType(event.actor),
      target: event.target || undefined,
      targetType: this.determineTargetType(event.target),
      action: event.action,
      details: (event.newState as any) || {},
      previousState: (event.previousState as any) || undefined,
      reason: event.reason || undefined,
      timestamp: event.createdAt,
      source: 'rbac.audit-logger',
    })) as AuditEvent[];

    return {
      events: auditEvents,
      total,
    };
  }

  /**
   * Generate compliance report
   */
  async generateComplianceReport(
    startDate: Date,
    endDate: Date,
    tenantId?: string
  ): Promise<{
    period: { start: Date; end: Date };
    tenantId?: string;
    summary: {
      totalEvents: number;
      securityViolations: number;
      permissionDenials: number;
      adminActions: number;
      sensitiveAccess: number;
    };
    details: {
      topActors: Array<{ actor: string; count: number }>;
      topTargets: Array<{ target: string; count: number }>;
      eventTypes: Array<{ type: string; count: number }>;
      severityDistribution: Array<{ severity: string; count: number }>;
    };
  }> {
    const { events } = await this.queryLogs({
      startDate,
      endDate,
      tenantId,
      limit: 10000, // Get large dataset for analysis
    });

    // Calculate summary metrics
    const summary = {
      totalEvents: events.length,
      securityViolations: events.filter(e => e.type.includes('security')).length,
      permissionDenials: events.filter(e => e.type === AuditEventType.PERMISSION_DENIED).length,
      adminActions: events.filter(e => e.type === AuditEventType.ADMIN_ACTION).length,
      sensitiveAccess: events.filter(e => e.type === AuditEventType.SENSITIVE_DATA_ACCESS).length,
    };

    // Calculate details
    const actorCounts = events.reduce((acc, event) => {
      acc[event.actor] = (acc[event.actor] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const targetCounts = events.reduce((acc, event) => {
      if (event.target) {
        acc[event.target] = (acc[event.target] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);

    const typeCounts = events.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const severityCounts = events.reduce((acc, event) => {
      acc[event.severity] = (acc[event.severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      period: { start: startDate, end: endDate },
      tenantId,
      summary,
      details: {
        topActors: Object.entries(actorCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([actor, count]) => ({ actor, count })),
        topTargets: Object.entries(targetCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([target, count]) => ({ target, count })),
        eventTypes: Object.entries(typeCounts)
          .sort(([, a], [, b]) => b - a)
          .map(([type, count]) => ({ type, count })),
        severityDistribution: Object.entries(severityCounts)
          .map(([severity, count]) => ({ severity, count })),
      },
    };
  }

  // ── Private Helper Methods ────────────────────────────────────────────────

  /**
   * Flush event queue to storage
   */
  private async flush(): Promise<void> {
    if (this.eventQueue.length === 0 || this.isFlushingToDatabase) return;

    const eventsToFlush = [...this.eventQueue];
    this.eventQueue = [];
    this.isFlushingToDatabase = true;

    try {
      if (this.config.logToDatabase) {
        await this.flushToDatabase(eventsToFlush);
      }

      if (this.config.logToFile) {
        await this.flushToFile(eventsToFlush);
      }
    } catch (error) {
      logger.error('Failed to flush audit events', { 
        error: error.message,
        eventCount: eventsToFlush.length,
      });

      // Put events back in queue for retry
      this.eventQueue.unshift(...eventsToFlush);
    } finally {
      this.isFlushingToDatabase = false;
    }
  }

  /**
   * Flush events to database
   */
  private async flushToDatabase(events: AuditEvent[]): Promise<void> {
    try {
      // Use existing AuditLog table format
      await prismaWrite.auditLog.createMany({
        data: events.map((event) => this.toAuditLogRow(event)),
      });

      logger.debug('Audit events flushed to database', { count: events.length });
    } catch (error) {
      logger.error('Database flush failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Flush events to file
   */
  private async flushToFile(events: AuditEvent[]): Promise<void> {
    // File logging implementation would go here
    // For now, just log the events
    events.forEach(event => {
      logger.info('AUDIT', event);
    });
  }

  /**
   * Encrypt sensitive fields in event
   */
  private encryptSensitiveFields(event: AuditEvent): AuditEvent {
    const encryptedEvent = { ...event };
    
    // Simple encryption placeholder - in production, use proper encryption
    this.config.sensitiveFields.forEach(field => {
      if (encryptedEvent.details[field]) {
        encryptedEvent.details[field] = `[ENCRYPTED:${crypto.createHash('sha256')
          .update(encryptedEvent.details[field])
          .digest('hex')
          .substring(0, 8)}]`;
      }
    });

    return encryptedEvent;
  }

  /**
   * Map an event to the `_audit_logs` row that is persisted for it.
   */
  private toAuditLogRow(event: AuditEvent) {
    return {
      id: event.id || crypto.randomUUID(),
      actor: event.actor,
      action: event.type,
      target: event.target || event.action,
      previousState: event.previousState || null,
      newState: {
        ...event.details,
        severity: event.severity,
        actorType: event.actorType,
        targetType: event.targetType,
        requestId: event.requestId,
        sessionId: event.sessionId,
        tenantId: event.tenantId,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        source: event.source,
        tags: event.tags,
        ...(event.checksum
          ? {
              checksum: event.checksum,
              previousChecksum: event.previousChecksum,
              integrityVersion: AUDIT_INTEGRITY_VERSION,
            }
          : {}),
      },
      reason: event.reason,
      createdAt: event.timestamp,
    };
  }

  /**
   * Add integrity check to event. The checksum covers the persisted row plus
   * the previous checksum, so it can be re-verified from the database (#1244).
   */
  private addIntegrityCheck(event: AuditEvent): AuditEvent {
    event.previousChecksum = this.lastEventChecksum;
    event.checksum = computeAuditRecordChecksum(this.toAuditLogRow(event), event.previousChecksum);
    this.lastEventChecksum = event.checksum;

    return event;
  }

  /**
   * Load last checksum for integrity chain
   */
  private async loadLastChecksum(): Promise<void> {
    try {
      const lastEvent = await prismaRead.auditLog.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { newState: true },
      });

      if (lastEvent?.newState && typeof lastEvent.newState === 'object') {
        this.lastEventChecksum = (lastEvent.newState as any).checksum;
      }
    } catch (error) {
      logger.warn('Failed to load last checksum', { error: error.message });
    }
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(error => {
        logger.error('Periodic flush failed', { error: error.message });
      });
    }, this.config.flushInterval);
  }

  /**
   * Stop flush timer and final flush
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    await this.flush();
  }

  /**
   * Helper methods for data transformation
   */
  private determineSeverity(action: string): AuditSeverity {
    if (action.includes('denied') || action.includes('violation') || action.includes('error')) {
      return AuditSeverity.ERROR;
    }
    if (action.includes('warning') || action.includes('suspicious')) {
      return AuditSeverity.WARNING;
    }
    if (action.includes('critical') || action.includes('security')) {
      return AuditSeverity.CRITICAL;
    }
    return AuditSeverity.INFO;
  }

  private determineActorType(actor: string): 'user' | 'api_key' | 'admin' | 'system' {
    if (actor === 'admin' || actor === 'system') return actor as any;
    if (actor.startsWith('key_')) return 'api_key';
    return 'user';
  }

  private determineTargetType(target?: string): string | undefined {
    if (!target) return undefined;
    if (target.includes('permission')) return 'permission';
    if (target.includes('role')) return 'role';
    if (target.includes('user')) return 'user';
    if (target.includes('tenant')) return 'tenant';
    return 'resource';
  }
}

// Singleton instance
export const rbacAuditLogger = new RbacAuditLogger({
  enabled: process.env.RBAC_AUDIT_ENABLED !== 'false',
  logToConsole: process.env.NODE_ENV === 'development',
  batchSize: parseInt(process.env.RBAC_AUDIT_BATCH_SIZE || '50', 10),
  flushInterval: parseInt(process.env.RBAC_AUDIT_FLUSH_INTERVAL || '5000', 10),
});

// Graceful shutdown
process.on('SIGTERM', () => {
  rbacAuditLogger.shutdown().catch(console.error);
});

process.on('SIGINT', () => {
  rbacAuditLogger.shutdown().catch(console.error);
});

export { AuditEventType, AuditSeverity };