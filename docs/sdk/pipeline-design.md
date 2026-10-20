# SDK Generation Pipeline - Production-Grade Design

## Overview

The SDK generation pipeline is a production-grade system that automatically generates typed SDKs for multiple programming languages from the OpenAPI specification. This document describes the architecture, design decisions, and production-grade features that ensure reliability, observability, and security.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     OpenAPI Spec Source                          │
│                 (src/indexer/swaggerSpec.ts)                     │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Normalization Layer                            │
│              (src/lib/openapi/normalize.ts)                      │
│  • Parse and validate OpenAPI spec                                │
│  • Normalize operations and parameters                            │
│  • Extract schemas and types                                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              SDK Generation Core                                  │
│              (scripts/sdk/generate.ts)                           │
│  • Feature flag validation                                       │
│  • Structured logging with correlation IDs                        │
│  • OpenTelemetry metrics collection                              │
│  • Graceful degradation with circuit breakers                     │
└────────────────────────┬────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────┐
│ TypeScript     │ │ Python      │ │ Parity      │
│ Emitter        │ │ Emitter     │ │ Matrix      │
│                │ │             │ │ Generator   │
└─────────────────┘ └─────────────┘ └─────────────┘
         │               │               │
         └───────────────┼───────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Output Generation & Validation                       │
│  • File writing with atomic operations                            │
│  • Drift detection (CI gate)                                      │
│  • Breaking change detection                                      │
│  • Security audit                                                │
└─────────────────────────────────────────────────────────────────┘
```

## Production-Grade Features

### 1. Structured Logging

**Implementation**: `scripts/sdk/sdk-logger.ts`

**Features**:
- Correlation IDs for request tracing
- Structured JSON logging in production
- Pretty-printed logs in development
- Component-level categorization
- Performance tracking (duration_ms)

**Usage**:
```typescript
import { logger } from './sdk-logger';

logger.info('SDK generation started', { 
  spec_version: '1.0.0',
  correlation_id: logger.getCorrelationId()
});
```

**Log Schema**:
```json
{
  "level": "info",
  "message": "SDK generation started",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "component": "sdk-generator",
  "correlation_id": "sdk-gen-1705325400000-abc123",
  "spec_version": "1.0.0"
}
```

### 2. OpenTelemetry Metrics

**Implementation**: `scripts/sdk/sdk-metrics.ts`

**Metrics Collected**:
- `sdk_generation_success_total`: Counter for successful generations
- `sdk_generation_failure_total`: Counter for failed generations
- `sdk_generation_duration_seconds`: Histogram for generation latency
- `sdk_files_generated_total`: Counter for files generated
- `sdk_drift_detected_total`: Counter for drift detection events
- `sdk_breaking_changes_total`: Counter for breaking changes
- `sdk_additive_changes_total`: Counter for additive changes

**SLO Targets**:
- Generation success rate: 99.9%
- P95 latency: < 5 seconds
- Drift detection rate: < 1%

**Integration**:
```typescript
import { metrics, METRIC_NAMES } from './sdk-metrics';

metrics.incrementCounter(METRIC_NAMES.GENERATION_SUCCESS);
metrics.recordHistogram(METRIC_NAMES.GENERATION_DURATION, 2.5);
```

### 3. Feature Flag System

**Implementation**: `scripts/sdk/feature-flags.ts`

**Capabilities**:
- Runtime feature toggling
- Dependency validation
- Gradual rollout support
- Environment variable configuration
- Rollback capability

**Available Flags**:
- `typescript-generation`: Enable TypeScript SDK generation (default: true)
- `python-generation`: Enable Python SDK generation (default: true)
- `drift-detection`: Enable drift detection (default: true)
- `breaking-change-detection`: Enable breaking change detection (default: true)
- `experimental-generators`: Enable experimental language generators (default: false)
- `strict-validation`: Enable strict validation (default: false)
- `parallel-generation`: Enable parallel file generation (default: false, 10% rollout)
- `telemetry-export`: Enable telemetry export (default: false)
- `cache-optimization`: Enable generation caching (default: false, 5% rollout)

**Configuration**:
```bash
# Enable a feature
export SDK_FEATURE_TYPESCRIPT_GENERATION=true

# Set rollout percentage
export SDK_ROLLOUT_PARALLEL_GENERATION=20
```

### 4. Graceful Degradation

**Implementation**: `scripts/sdk/graceful-degradation.ts`

**Features**:
- Critical vs optional component classification
- Automatic retry with exponential backoff
- Circuit breaker pattern for failing components
- Fallback implementations for non-critical failures
- Partial success reporting

**Component Handlers**:
```typescript
const handlers: ComponentHandler[] = [
  {
    name: 'typescript-core',
    critical: true,  // Failure blocks entire generation
    execute: () => generateTypeScriptFiles(),
  },
  {
    name: 'python-sdk',
    critical: false,  // Failure is acceptable
    execute: () => generatePythonFiles(),
    fallback: () => [],  // Skip if failed
  },
  {
    name: 'parity-matrix',
    critical: false,
    execute: () => generateParityMatrix(),
    fallback: fallbacks.parityMatrix,  // Use fallback
  },
];
```

**Circuit Breaker Configuration**:
- Default threshold: 5 failures
- Default timeout: 60 seconds
- Configurable via `gracefulDegradation.configure()`

### 5. Security Audit

**Implementation**: `scripts/sdk/security-audit.ts`

**Security Checks**:
- Secret detection in OpenAPI spec
- SSRF risk assessment
- Injection vulnerability scanning
- Authentication requirement validation
- Hardcoded secret detection in generated code
- Unsafe dependency identification
- CI workflow security analysis

**Audit Categories**:
- **Critical**: Code injection, hardcoded secrets, unrestricted permissions
- **High**: SSRF risks, vulnerable dependencies, unsafe dependencies
- **Medium**: Authentication gaps, injection risks, data exposure
- **Low**: Unnecessary dependencies, outdated dependencies

**Usage**:
```bash
npm run sdk:audit:security
```

### 6. Performance Benchmarks

**Implementation**: `src/benchmarks/sdk-generation.bench.ts`

**Benchmark Categories**:
- Generation latency for various spec sizes
- Metrics collection overhead
- Feature flag performance
- Graceful degradation performance
- Memory usage patterns
- Throughput under load

**Running Benchmarks**:
```bash
npm run sdk:bench
```

### 7. Load Testing

**Implementation**: `tests/sdk-load.test.ts`

**Test Scenarios**:
- Sustained load (100-500 consecutive generations)
- Memory leak detection
- Concurrent request handling
- Burst traffic patterns
- Resource exhaustion testing
- SLO compliance validation

**Running Load Tests**:
```bash
npm run sdk:test:load
```

### 8. Chaos Testing

**Implementation**: `tests/sdk-chaos.test.ts`

**Chaos Scenarios**:
- Circuit breaker activation
- Retry logic validation
- Fallback mechanism testing
- Critical vs optional handler behavior
- Feature flag integration
- Transient failure recovery

**Running Chaos Tests**:
```bash
npm run sdk:test:chaos
```

### 9. Content-Addressed Generation Caching

**Implementation**: `scripts/sdk/cache.ts`

**Overview**:
To avoid repeated code generation in local development and CI pipelines, generated SDK artifacts are cached using content-addressed hashing.

**Cache Key Composition**:
Cache keys are computed deterministically as the SHA-256 digest of:
1. **Canonical OpenAPI specification content**: canonical JSON serialization of the OpenAPI document (`sha256(canonicalDoc)`)
2. **Generator & toolchain versions**: generator version (`GENERATOR_VERSION`), Node.js runtime version (`process.version`)
3. **Emitter source code**: content hashes of `scripts/sdk/generate.ts`, `emit-typescript.ts`, `emit-python.ts`, `emit-java.ts`, `surface.ts`, `parity.ts`
4. **Configuration & feature flags**: active flag set

**Byte-Identical Output Guarantee**:
Every cached file entry stores its SHA-256 checksum in a manifest. A cache hit restores files whose hashes match clean generation byte-for-byte.

**Corruption and Absence Diagnostics**:
- **Cache Absence**: Emits `Diagnostic: Cache entry absent for key <key>; executing clean generation.`
- **Cache Corruption** (checksum mismatch or malformed JSON): Emits `Diagnostic: Cache corruption detected: ... Falling back to clean run.` and executes a clean generation without halting the build.

**Cache Invalidation & Local Cleanup**:
- **Automatic Invalidation**: Any change to OpenAPI endpoints, models, parameters, emitter source code, or generator version changes the cache key, automatically invalidating stale cache entries.
- **Manual Cleanup**:
  ```bash
  # Delete local cache directory
  npm run sdk:cache:clean
  # Or run generation bypassing cache
  npm run sdk:generate -- --no-cache
  ```

## SLO and Error Budgets

**Service Level Objectives**:
- Generation Success Rate: 99.9% (43.2 min/month error budget)
- P95 Latency: < 5 seconds
- Drift Detection Rate: < 1%
- Breaking Change Accuracy: 100%

**Error Budget Policy**:
- **Healthy (>50% remaining)**: Normal operations
- **Depleting (25-50%)**: Reduced deployment frequency, enhanced monitoring
- **Critical (<25%)**: Deployment freeze, on-call escalation
- **Exhausted (0%)**: Complete freeze, emergency response

**Monitoring**: See `docs/sdk/slo-error-budgets.md` and `docs/sdk/grafana-dashboard.json`

## Error Taxonomy

### Generation Errors

**SDK_GENERATION_FAILED**
- Severity: Critical
- Impact: Complete generation failure
- Recovery: Retry with backoff, check OpenAPI spec validity
- Metrics: `sdk_generation_failure_total`

**EMITTER_FAILED**
- Severity: High (for critical emitters), Medium (for optional)
- Impact: Partial generation (if optional emitter)
- Recovery: Use fallback if available, retry
- Metrics: Emitter-specific counters

**NORMALIZATION_FAILED**
- Severity: Critical
- Impact: Cannot process OpenAPI spec
- Recovery: Validate OpenAPI spec syntax
- Metrics: `sdk_generation_failure_total`

### Validation Errors

**DRIFT_DETECTED**
- Severity: Medium
- Impact: Generated files out of sync with spec
- Recovery: Run `npm run sdk:generate` and commit
- Metrics: `sdk_drift_detected_total`

**BREAKING_CHANGE_VIOLATION**
- Severity: High
- Impact: Semver policy violation
- Recovery: Bump version appropriately or restore compatibility
- Metrics: `sdk_breaking_changes_total`

**FEATURE_FLAG_VALIDATION_FAILED**
- Severity: Critical
- Impact: Feature flag dependency error
- Recovery: Fix feature flag configuration
- Metrics: Validation error counter

### Runtime Errors

**CIRCUIT_BREAKER_OPEN**
- Severity: Medium
- Impact: Component temporarily disabled
- Recovery: Wait for timeout, then retry
- Metrics: Circuit breaker status

**RETRY_EXHAUSTED**
- Severity: High
- Impact: Component failed after all retries
- Recovery: Investigate root cause, fix component
- Metrics: Retry counter

**FALLBACK_FAILED**
- Severity: Medium
- Impact: Fallback implementation failed
- Recovery: Fix fallback or implement alternative
- Metrics: Fallback failure counter

## Operational Procedures

### Daily Operations

1. **Monitor Dashboards**
   - Check Grafana SLO dashboard
   - Review error budget consumption
   - Monitor generation success rate

2. **Review Logs**
   - Check for error patterns
   - Monitor performance degradation
   - Review security audit results

3. **Run Health Checks**
   ```bash
   npm run sdk:check          # Drift detection
   npm run sdk:breaking       # Semver validation
   npm run sdk:audit:security # Security audit
   ```

### Release Process

1. **Pre-Release Validation**
   ```bash
   npm run sdk:generate       # Generate SDKs
   npm run sdk:check          # Verify no drift
   npm run sdk:breaking       # Check semver compliance
   npm run sdk:audit:security # Security audit
   npm run sdk:test:chaos     # Chaos tests
   npm run sdk:test:load      # Load tests
   npm run sdk:bench          # Performance benchmarks
   ```

2. **Version Bump**
   - Update package versions per semver policy
   - Update CHANGELOG.md
   - Commit changes

3. **Tag and Publish**
   ```bash
   git tag client-v<version>
   git push origin client-v<version>
   # CI will handle publishing with provenance
   ```

### Incident Response

**SEV1 (Critical)**
- Response time: 15 minutes
- Actions: Stop deployments, enable emergency mode, investigate root cause
- Escalation: On-call + engineering manager

**SEV2 (High)**
- Response time: 30 minutes
- Actions: Reduce deployment frequency, enhance monitoring
- Escalation: On-call

**SEV3 (Medium)**
- Response time: 1 hour
- Actions: Monitor closely, plan fix
- Escalation: Team lead

**SEV4 (Low)**
- Response time: 4 hours
- Actions: Add to backlog, schedule fix
- Escalation: None

## Rollback Procedures

### SDK Rollback

1. **Deprecate Bad Release**
   ```bash
   npm deprecate @soroban-explorer/client@<bad-version> "Use <good-version>"
   ```

2. **Restore Latest Good Version**
   ```bash
   npm dist-tag add @soroban-explorer/client@<good-version> latest
   ```

3. **Repository Rollback**
   ```bash
   git revert <commit-hash>
   git push origin main
   ```

### Pipeline Rollback

1. **Disable Problematic Feature Flags**
   ```bash
   export SDK_FEATURE_EXPERIMENTAL_GENERATORS=false
   ```

2. **Reset Circuit Breakers**
   - Manual intervention via admin interface
   - Or wait for automatic timeout

3. **Restore Previous Configuration**
   - Revert configuration changes
   - Restart pipeline services

## Security Considerations

### Input Validation
- OpenAPI spec validation before processing
- Parameter type checking in generated SDKs
- Path traversal prevention
- SQL injection prevention in database operations

### Secret Management
- No hardcoded secrets in code
- Environment variable configuration
- Secret scanning in CI/CD
- Provenance verification for published packages

### Access Control
- API key authentication for SDK usage
- Rate limiting per API key
- IP whitelisting for internal operations
- Audit logging for sensitive operations

### Dependency Security
- Regular dependency audits
- Automated vulnerability scanning
- Supply chain attack prevention
- Minimal dependency footprint

## Monitoring and Alerting

### Key Metrics
- Generation success rate
- P95 latency
- Error rate by category
- Circuit breaker status
- Feature flag adoption rates

### Alert Thresholds
- **Critical**: Success rate < 99%, latency > 10s, error budget burn rate > 5x
- **Warning**: Success rate < 99.5%, latency > 7s, error budget burn rate > 2x
- **Info**: Latency > 5s, drift detection rate > 0.1%

### Dashboards
- SLO Dashboard: `docs/sdk/grafana-dashboard.json`
- Error Budget Dashboard: Custom Grafana configuration
- Performance Dashboard: Benchmark results visualization

## Continuous Improvement

### Regular Reviews
- **Weekly**: Error budget consumption review
- **Monthly**: Performance trend analysis
- **Quarterly**: SLO target assessment
- **Annually**: Architecture review

### Improvement Metrics
- Mean Time To Detect (MTTD)
- Mean Time To Resolve (MTTR)
- False positive rate on alerts
- Test coverage percentage
- Documentation completeness

## Documentation

### Design Documents
- TypeScript SDK: `docs/sdk/typescript/design.md`
- Python SDK: `docs/sdk/python/design.md`
- Pipeline: `docs/sdk/pipeline-design.md` (this document)

### Runbooks
- TypeScript SDK: `docs/sdk/typescript/runbook.md`
- Python SDK: `docs/sdk/python/runbook.md`
- SLO Monitoring: `docs/sdk/slo-error-budgets.md`

### API References
- TypeScript SDK: `docs/sdk/typescript/api-reference.md`
- Python SDK: `docs/sdk/python/api-reference.md`

## Future Enhancements

### Planned Features
- [x] Java language emitter (`packages/java-client`) with parity against OpenAPI contract
- [ ] Additional language emitters (Go, C#)
- [ ] Real-time spec monitoring and auto-generation
- [x] Advanced caching strategies (content-addressed caching by OpenAPI content hash)
- [ ] Distributed generation for large specs
- [ ] Machine learning for spec quality analysis

### Performance Improvements
- [x] Parallel file generation (bounded worker pool in `scripts/sdk/parallel-generator.ts`)
- [ ] Incremental generation (only changed operations)
- [ ] Spec compilation and caching
- [ ] Optimized normalization algorithms

### Security Enhancements
- [ ] Advanced secret detection with ML
- [ ] Runtime vulnerability scanning
- [ ] Dependency signature verification
- [ ] Enhanced supply chain security

## Conclusion

The SDK generation pipeline is designed with production-grade features that ensure reliability, observability, and security. The combination of structured logging, OpenTelemetry metrics, feature flags, graceful degradation, and comprehensive testing provides a robust foundation for generating high-quality SDKs that drive API adoption while maintaining low integration friction.
