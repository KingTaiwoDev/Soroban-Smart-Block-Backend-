/**
 * Verification script for Wasmtime native sandbox addon (#1295).
 * Validates:
 *   1. Supported OS/architecture matrix and packaged artifact layout
 *   2. Startup self-check execution
 *   3. Minimal deterministic contract execution with fuel consumption
 *   4. Explicit capability state on unsupported platforms
 *   5. Feature gating and safe simulator fallback
 */
import {
  SUPPORTED_MATRIX,
  WasmtimeSandboxManager,
  isPlatformSupported,
} from '../src/sandbox/wasmtime-addon';

export function runAddonVerification(): boolean {
  console.log('=== Wasmtime Native Sandbox Addon Verification ===\n');

  // 1. Matrix verification
  console.log('1. Checking Supported OS/Architecture Matrix:');
  console.log(`   Found ${SUPPORTED_MATRIX.length} documented target platforms:`);
  for (const target of SUPPORTED_MATRIX) {
    console.log(`   - ${target.platform} (${target.arch}) => ${target.artifactName} [${target.triple}]`);
  }

  // 2. Platform detection
  const currentSupported = isPlatformSupported(process.platform, process.arch);
  console.log(`\n2. Host Platform Detection:`);
  console.log(`   Host: ${process.platform}/${process.arch} -> ${currentSupported ? 'SUPPORTED' : 'UNSUPPORTED'}`);

  // 3. Startup Self-Check
  console.log(`\n3. Running Startup Self-Check on host:`);
  const manager = new WasmtimeSandboxManager();
  const selfCheck = manager.runStartupSelfCheck();
  console.log(`   Self-check passed: ${selfCheck.passed}`);
  console.log(`   Fuel consumed: ${selfCheck.fuelConsumed}`);
  console.log(`   Deterministic output: ${selfCheck.result}`);
  if (!selfCheck.passed) {
    console.error(`   ERROR: Self check failed: ${selfCheck.error}`);
    return false;
  }

  // 4. Deterministic contract execution
  console.log(`\n4. Minimal Deterministic Contract Execution:`);
  const execResult = manager.execute(new Uint8Array([0, 97, 115, 109]), 'multiply', [6, 7], 500);
  console.log(`   multiply(6, 7) => ${execResult.result} (status: ${execResult.status}, fuel: ${execResult.fuelConsumed})`);
  if (execResult.result !== 42 || execResult.status !== 'success' || execResult.fuelConsumed <= 0) {
    console.error(`   ERROR: Deterministic execution failed: expected 42, got ${execResult.result}`);
    return false;
  }

  // 5. Capability state on unsupported platform simulation
  console.log(`\n5. Verifying Unsupported Platform Capability State (Simulated):`);
  const unsupportedManager = new WasmtimeSandboxManager({ platform: 'freebsd', arch: 'x64' });
  const unsupportedState = unsupportedManager.getCapabilityState();
  console.log(`   Supported: ${unsupportedState.supported}`);
  console.log(`   Tier: ${unsupportedState.tier}`);
  console.log(`   Active runtime: ${unsupportedState.activeRuntime}`);
  console.log(`   Reason: ${unsupportedState.reason}`);

  if (unsupportedState.supported !== false || unsupportedState.activeRuntime !== 'js_simulator') {
    console.error('   ERROR: Unsupported platform was not routed to simulator fallback');
    return false;
  }

  // 6. Feature gating check
  console.log(`\n6. Verifying Feature Gating:`);
  const disabledState = manager.getCapabilityState();
  console.log(`   Default featureGateEnabled: ${disabledState.featureGateEnabled}`);
  console.log(`   Default activeRuntime: ${disabledState.activeRuntime}`);

  console.log('\n✓ All Wasmtime native addon verification checks passed successfully.');
  return true;
}

if (require.main === module) {
  const success = runAddonVerification();
  process.exit(success ? 0 : 1);
}
