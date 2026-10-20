/**
 * Feature flag system for SDK generation pipeline.
 * Provides runtime control over SDK generation features with safety defaults.
 */

interface FeatureFlagConfig {
  enabled: boolean;
  description: string;
  rolloutPercentage?: number;
  dependsOn?: string[];
}

class FeatureFlags {
  private flags: Map<string, FeatureFlagConfig> = new Map();
  private rolloutCache: Map<string, boolean> = new Map();

  constructor() {
    this.initializeDefaultFlags();
    this.loadFromEnvironment();
  }

  private initializeDefaultFlags(): void {
    // Core features - always enabled by default
    this.registerFlag('typescript-generation', {
      enabled: true,
      description: 'Generate TypeScript SDK',
    });

    this.registerFlag('python-generation', {
      enabled: true,
      description: 'Generate Python SDK',
    });

    this.registerFlag('java-generation', {
      enabled: true,
      description: 'Generate Java SDK',
    });

    this.registerFlag('drift-detection', {
      enabled: true,
      description: 'Enable drift detection in CI',
    });

    this.registerFlag('breaking-change-detection', {
      enabled: true,
      description: 'Enable breaking change detection',
    });

    // Optional features - disabled by default for safety
    this.registerFlag('experimental-generators', {
      enabled: false,
      description: 'Enable experimental language generators',
    });

    this.registerFlag('strict-validation', {
      enabled: false,
      description: 'Enable strict validation with early failure',
      dependsOn: ['drift-detection'],
    });

    this.registerFlag('parallel-generation', {
      enabled: true,
      description: 'Enable parallel file generation',
      rolloutPercentage: 100,
    });

    this.registerFlag('telemetry-export', {
      enabled: false,
      description: 'Export telemetry to external monitoring',
    });

    this.registerFlag('cache-optimization', {
      enabled: false,
      description: 'Enable generation caching for faster builds',
      rolloutPercentage: 5,
    });
  }

  private loadFromEnvironment(): void {
    // Load feature flags from environment variables
    // Format: SDK_FEATURE_<FLAG_NAME>=true|false
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('SDK_FEATURE_')) {
        const flagName = key.slice('SDK_FEATURE_'.length).toLowerCase().replace(/_/g, '-');
        const isEnabled = value.toLowerCase() === 'true' || value === '1';
        
        if (this.flags.has(flagName)) {
          const config = this.flags.get(flagName)!;
          config.enabled = isEnabled;
          this.flags.set(flagName, config);
        }
      }
    }

    // Set rollout percentage from environment
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('SDK_ROLLOUT_')) {
        const flagName = key.slice('SDK_ROLLOUT_'.length).toLowerCase().replace(/_/g, '-');
        const percentage = parseInt(value, 10);
        
        if (this.flags.has(flagName) && !isNaN(percentage)) {
          const config = this.flags.get(flagName)!;
          config.rolloutPercentage = percentage;
          this.flags.set(flagName, config);
        }
      }
    }
  }

  registerFlag(name: string, config: FeatureFlagConfig): void {
    this.flags.set(name, config);
  }

  isEnabled(flagName: string, context?: { correlationId?: string }): boolean {
    const config = this.flags.get(flagName);
    
    if (!config) {
      console.warn(`Unknown feature flag: ${flagName}`);
      return false;
    }

    // Check dependencies
    if (config.dependsOn) {
      for (const dep of config.dependsOn) {
        if (!this.isEnabled(dep, context)) {
          return false;
        }
      }
    }

    // If not explicitly enabled, return false
    if (!config.enabled) {
      return false;
    }

    // Check rollout percentage
    if (config.rolloutPercentage !== undefined) {
      const cacheKey = `${flagName}-${context?.correlationId || 'default'}`;
      
      if (this.rolloutCache.has(cacheKey)) {
        return this.rolloutCache.get(cacheKey)!;
      }

      const shouldEnable = this.determineRollout(config.rolloutPercentage, context);
      this.rolloutCache.set(cacheKey, shouldEnable);
      return shouldEnable;
    }

    return true;
  }

  private determineRollout(percentage: number, context?: { correlationId?: string }): boolean {
    // Use correlation ID for consistent rollout decisions
    const seed = context?.correlationId || Math.random().toString();
    const hash = this.simpleHash(seed);
    const scaled = (hash % 100) + 1; // 1-100
    return scaled <= percentage;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  getFlag(flagName: string): FeatureFlagConfig | undefined {
    return this.flags.get(flagName);
  }

  getAllFlags(): Map<string, FeatureFlagConfig> {
    return new Map(this.flags);
  }

  getEnabledFlags(): string[] {
    return Array.from(this.flags.entries())
      .filter(([_, config]) => this.isEnabled(_))
      .map(([name]) => name);
  }

  validateDependencies(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    for (const [name, config] of this.flags) {
      if (config.dependsOn) {
        for (const dep of config.dependsOn) {
          if (!this.flags.has(dep)) {
            errors.push(`Flag '${name}' depends on unknown flag '${dep}'`);
          }
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Singleton instance
export const featureFlags = new FeatureFlags();

// Flag name constants for type safety
export const FLAG_NAMES = {
  TYPESCRIPT_GENERATION: 'typescript-generation',
  PYTHON_GENERATION: 'python-generation',
  JAVA_GENERATION: 'java-generation',
  DRIFT_DETECTION: 'drift-detection',
  BREAKING_CHANGE_DETECTION: 'breaking-change-detection',
  EXPERIMENTAL_GENERATORS: 'experimental-generators',
  STRICT_VALIDATION: 'strict-validation',
  PARALLEL_GENERATION: 'parallel-generation',
  TELEMETRY_EXPORT: 'telemetry-export',
  CACHE_OPTIMIZATION: 'cache-optimization',
} as const;
