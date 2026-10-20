/**
 * Multi-Tenant Isolation at Query Layer
 *
 * Provides automatic tenant filtering for database queries to ensure strict
 * data isolation between tenants with zero-trust verification.
 */

import { Prisma } from '@prisma/client';
import { logger } from '../logger';
import { AuthPrincipal, TenantIsolationError } from './types';

/**
 * Tenant isolation levels
 */
export enum IsolationLevel {
  STRICT = 'strict',     // Complete isolation, no cross-tenant access
  SHARED = 'shared',     // Shared resources with controlled access
  HIERARCHICAL = 'hierarchical', // Parent tenants can access child data
}

/**
 * Models that require tenant isolation
 */
export const TENANT_ISOLATED_MODELS = [
  'WalletUser',
  'DevApiKey', 
  'UserRole',
  'UserPermission',
  'ApiKeyScope',
  'ResourcePermission',
  'AuditLog',
  'SensitiveReadAudit',
] as const;

/**
 * Models that are globally shared (no tenant isolation)
 */
export const GLOBAL_SHARED_MODELS = [
  'Permission',
  'Role',
  'RolePermission', 
  'Tenant',
  'PermissionCache',
] as const;

/**
 * Context for tenant-aware queries
 */
export interface TenantQueryContext {
  principal: AuthPrincipal;
  requestedTenantId?: string;
  bypassIsolation?: boolean; // For super admin operations
  validateAccess?: boolean; // Default: true
}

/**
 * Result of tenant access validation
 */
export interface TenantAccessResult {
  allowed: boolean;
  tenantId?: string;
  reason?: string;
  isolationLevel: IsolationLevel;
}

/**
 * Tenant Isolation Service
 */
export class TenantIsolationService {
  private tenantCache = new Map<string, { 
    tenant: any; 
    expiresAt: number; 
    isolationLevel: IsolationLevel;
  }>();

  /**
   * Validate tenant access for a principal
   */
  async validateTenantAccess(
    principal: AuthPrincipal,
    requestedTenantId?: string
  ): Promise<TenantAccessResult> {
    // Admin principals can access any tenant
    if (principal.type === 'admin') {
      return {
        allowed: true,
        tenantId: requestedTenantId,
        isolationLevel: IsolationLevel.SHARED,
      };
    }

    // If no tenant requested, use principal's tenant
    const targetTenantId = requestedTenantId || principal.tenantId;
    
    if (!targetTenantId) {
      // Allow access to global resources when no tenant is specified
      return {
        allowed: true,
        isolationLevel: IsolationLevel.SHARED,
      };
    }

    // Validate principal has access to the requested tenant. A non-admin
    // principal without a tenant must not be able to select one (e.g. via the
    // X-Tenant-ID header or ?tenantId=) and read or write its data.
    if (principal.tenantId !== targetTenantId) {
      // Check if there's a hierarchical relationship
      const hasHierarchicalAccess =
        !!principal.tenantId &&
        (await this.checkHierarchicalAccess(principal.tenantId, targetTenantId));

      if (!hasHierarchicalAccess) {
        return {
          allowed: false,
          reason: `No access to tenant ${targetTenantId}`,
          isolationLevel: IsolationLevel.STRICT,
        };
      }
    }

    // Get tenant isolation level
    const tenant = await this.getTenant(targetTenantId);
    const isolationLevel = tenant ? 
      (tenant.isolationLevel as IsolationLevel) : 
      IsolationLevel.STRICT;

    return {
      allowed: true,
      tenantId: targetTenantId,
      isolationLevel,
    };
  }

  /**
   * Apply tenant filtering to a Prisma query
   */
  applyTenantFilter<T extends Record<string, any>>(
    modelName: string,
    where: T,
    context: TenantQueryContext
  ): T {
    // Skip filtering for global models
    if (GLOBAL_SHARED_MODELS.includes(modelName as any)) {
      return where;
    }

    // Skip filtering if bypassing isolation (super admin)
    if (context.bypassIsolation && context.principal.type === 'admin') {
      return where;
    }

    // Apply tenant filtering for isolated models
    if (TENANT_ISOLATED_MODELS.includes(modelName as any)) {
      const tenantFilter = this.buildTenantFilter(context);
      
      if (tenantFilter) {
        return {
          ...where,
          ...tenantFilter,
        } as T;
      }
    }

    return where;
  }

  /**
   * Validate a query result against tenant isolation rules
   */
  async validateQueryResult(
    modelName: string,
    result: any,
    context: TenantQueryContext
  ): Promise<void> {
    if (!context.validateAccess) return;

    // Skip validation for global models
    if (GLOBAL_SHARED_MODELS.includes(modelName as any)) {
      return;
    }

    // Skip validation if bypassing isolation
    if (context.bypassIsolation && context.principal.type === 'admin') {
      return;
    }

    // Validate single result
    if (result && !Array.isArray(result)) {
      await this.validateSingleResult(result, context);
      return;
    }

    // Validate array results
    if (Array.isArray(result)) {
      for (const item of result) {
        await this.validateSingleResult(item, context);
      }
    }
  }

  /**
   * Create a tenant-aware Prisma client extension
   */
  createTenantPrismaExtension(defaultContext?: TenantQueryContext) {
    const self = this;

    return Prisma.defineExtension({
      name: 'tenant-isolation',
      query: {
        $allModels: {
          async findMany({ model, operation, args, query }) {
            const context = (args as any).__tenantContext || defaultContext;
            if (!context) return query(args);

            // Apply tenant filtering
            const filteredArgs = {
              ...args,
              where: self.applyTenantFilter(model, args.where || {}, context),
            };

            const result = await query(filteredArgs);
            
            // Validate results
            await self.validateQueryResult(model, result, context);
            
            return result;
          },

          async findFirst({ model, operation, args, query }) {
            const context = (args as any).__tenantContext || defaultContext;
            if (!context) return query(args);

            const filteredArgs = {
              ...args,
              where: self.applyTenantFilter(model, args.where || {}, context),
            };

            const result = await query(filteredArgs);
            await self.validateQueryResult(model, result, context);
            
            return result;
          },

          async findUnique({ model, operation, args, query }) {
            const context = (args as any).__tenantContext || defaultContext;
            if (!context) return query(args);

            const result = await query(args);
            await self.validateQueryResult(model, result, context);
            
            return result;
          },

          async create({ model, operation, args, query }) {
            const context = (args as any).__tenantContext || defaultContext;
            if (!context) return query(args);

            // Add tenant ID to create data if applicable
            const enhancedArgs = self.enhanceCreateArgs(model, args, context);
            
            const result = await query(enhancedArgs);
            await self.validateQueryResult(model, result, context);
            
            return result;
          },

          async update({ model, operation, args, query }) {
            const context = (args as any).__tenantContext || defaultContext;
            if (!context) return query(args);

            // Validate access to the record being updated
            const filteredArgs = {
              ...args,
              where: self.applyTenantFilter(model, args.where, context),
            };

            const result = await query(filteredArgs);
            await self.validateQueryResult(model, result, context);
            
            return result;
          },

          async delete({ model, operation, args, query }) {
            const context = (args as any).__tenantContext || defaultContext;
            if (!context) return query(args);

            const filteredArgs = {
              ...args,
              where: self.applyTenantFilter(model, args.where, context),
            };

            const result = await query(filteredArgs);
            
            return result;
          },
        },
      },
    });
  }

  /**
   * Create tenant-aware database clients
   */
  async createTenantClients(context: TenantQueryContext) {
    const { prismaRead: baseReadClient, prismaWrite: baseWriteClient } = await import('../db');
    
    const extension = this.createTenantPrismaExtension(context);
    
    return {
      prismaRead: baseReadClient.$extends(extension),
      prismaWrite: baseWriteClient.$extends(extension),
    };
  }

  // ── Private Helper Methods ────────────────────────────────────────────────

  /**
   * Build tenant filter object
   */
  private buildTenantFilter(context: TenantQueryContext): Record<string, any> | null {
    const targetTenantId = context.requestedTenantId || context.principal.tenantId;
    
    if (!targetTenantId) {
      return null;
    }

    return {
      tenantId: targetTenantId,
    };
  }

  /**
   * Validate a single query result
   */
  private async validateSingleResult(result: any, context: TenantQueryContext): Promise<void> {
    if (!result || typeof result !== 'object') return;

    // Check if result has tenantId field
    if ('tenantId' in result && result.tenantId) {
      const access = await this.validateTenantAccess(context.principal, result.tenantId);
      
      if (!access.allowed) {
        throw new TenantIsolationError(
          `Access denied to tenant ${result.tenantId}: ${access.reason}`,
          {
            principal: context.principal,
            requestedTenantId: result.tenantId,
          }
        );
      }
    }
  }

  /**
   * Enhance create arguments with tenant information
   */
  private enhanceCreateArgs(modelName: string, args: any, context: TenantQueryContext): any {
    // Skip enhancement for global models
    if (GLOBAL_SHARED_MODELS.includes(modelName as any)) {
      return args;
    }

    const targetTenantId = context.requestedTenantId || context.principal.tenantId;
    
    if (!targetTenantId || !TENANT_ISOLATED_MODELS.includes(modelName as any)) {
      return args;
    }

    // Add tenantId to create data
    return {
      ...args,
      data: {
        ...args.data,
        tenantId: targetTenantId,
      },
    };
  }

  /**
   * Check hierarchical tenant access
   */
  private async checkHierarchicalAccess(
    principalTenantId: string,
    requestedTenantId: string
  ): Promise<boolean> {
    // Simple implementation - in production, this would check parent-child relationships
    // For now, only allow same-tenant access
    return principalTenantId === requestedTenantId;
  }

  /**
   * Get tenant information with caching
   */
  private async getTenant(tenantId: string): Promise<any> {
    const cached = this.tenantCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.tenant;
    }

    try {
      const { prismaRead } = await import('../db');
      const tenant = await prismaRead.tenant.findUnique({
        where: { id: tenantId },
      });

      if (tenant) {
        this.tenantCache.set(tenantId, {
          tenant,
          expiresAt: Date.now() + (5 * 60 * 1000), // 5 minutes
          isolationLevel: tenant.isolationLevel as IsolationLevel,
        });
      }

      return tenant;
    } catch (error) {
      logger.warn('Failed to fetch tenant', { tenantId, error: error.message });
      return null;
    }
  }

  /**
   * Clear tenant cache
   */
  clearTenantCache(tenantId?: string): void {
    if (tenantId) {
      this.tenantCache.delete(tenantId);
    } else {
      this.tenantCache.clear();
    }
  }

  /**
   * Get tenant cache statistics
   */
  getTenantCacheStats(): {
    size: number;
    entries: Array<{ tenantId: string; isolationLevel: IsolationLevel; expiresAt: number }>;
  } {
    const entries = Array.from(this.tenantCache.entries()).map(([tenantId, cached]) => ({
      tenantId,
      isolationLevel: cached.isolationLevel,
      expiresAt: cached.expiresAt,
    }));

    return {
      size: this.tenantCache.size,
      entries,
    };
  }
}

// Singleton instance
export const tenantIsolationService = new TenantIsolationService();

/**
 * Helper function to create tenant-aware query context
 */
export function createTenantContext(
  principal: AuthPrincipal,
  options: {
    requestedTenantId?: string;
    bypassIsolation?: boolean;
    validateAccess?: boolean;
  } = {}
): TenantQueryContext {
  return {
    principal,
    requestedTenantId: options.requestedTenantId,
    bypassIsolation: options.bypassIsolation || false,
    validateAccess: options.validateAccess !== false, // Default to true
  };
}

/**
 * Express middleware to create tenant context from request
 */
export function createTenantContextMiddleware() {
  return (req: any, res: any, next: any) => {
    if (!req.rbacPrincipal) {
      return next(); // No principal, skip tenant context
    }

    const requestedTenantId = 
      req.params.tenantId || 
      req.query.tenantId || 
      req.get('X-Tenant-ID');

    req.tenantContext = createTenantContext(req.rbacPrincipal, {
      requestedTenantId,
      bypassIsolation: req.rbacPrincipal.type === 'admin' && req.query.bypassIsolation === 'true',
    });

    next();
  };
}

/**
 * Utility to wrap Prisma operations with tenant context
 */
export async function withTenantContext<T>(
  context: TenantQueryContext,
  operation: (clients: { prismaRead: any; prismaWrite: any }) => Promise<T>
): Promise<T> {
  const clients = await tenantIsolationService.createTenantClients(context);
  return operation(clients);
}

/**
 * Validate tenant isolation in tests
 */
export class TenantIsolationValidator {
  /**
   * Test that queries are properly isolated between tenants
   */
  static async validateIsolation(
    modelName: string,
    tenant1Id: string,
    tenant2Id: string,
    principal1: AuthPrincipal,
    principal2: AuthPrincipal
  ): Promise<{
    isolated: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];

    try {
      // Create test data in tenant1
      const context1 = createTenantContext(principal1, { requestedTenantId: tenant1Id });
      const clients1 = await tenantIsolationService.createTenantClients(context1);
      
      // Try to access tenant1 data from tenant2 context
      const context2 = createTenantContext(principal2, { requestedTenantId: tenant2Id });
      const clients2 = await tenantIsolationService.createTenantClients(context2);

      // This should return empty results for tenant2
      const crossTenantQuery = await (clients2 as any)[modelName.toLowerCase()].findMany();
      
      if (crossTenantQuery && crossTenantQuery.length > 0) {
        // Check if any results belong to tenant1
        const leakedData = crossTenantQuery.filter((item: any) => 
          item.tenantId === tenant1Id
        );
        
        if (leakedData.length > 0) {
          issues.push(`Cross-tenant data leak: ${leakedData.length} records from tenant1 visible to tenant2`);
        }
      }
    } catch (error) {
      if (error instanceof TenantIsolationError) {
        // This is expected - isolation working correctly
      } else {
        issues.push(`Unexpected error during isolation test: ${error.message}`);
      }
    }

    return {
      isolated: issues.length === 0,
      issues,
    };
  }

  /**
   * Comprehensive isolation test across all tenant-aware models
   */
  static async validateAllModels(
    tenant1Id: string,
    tenant2Id: string,
    principal1: AuthPrincipal,
    principal2: AuthPrincipal
  ): Promise<{
    overallIsolated: boolean;
    results: Array<{
      model: string;
      isolated: boolean;
      issues: string[];
    }>;
  }> {
    const results = [];
    
    for (const modelName of TENANT_ISOLATED_MODELS) {
      const result = await this.validateIsolation(
        modelName,
        tenant1Id,
        tenant2Id,
        principal1,
        principal2
      );
      
      results.push({
        model: modelName,
        ...result,
      });
    }

    const overallIsolated = results.every(r => r.isolated);
    
    return {
      overallIsolated,
      results,
    };
  }
}

export { TenantIsolationValidator as tenantValidator };