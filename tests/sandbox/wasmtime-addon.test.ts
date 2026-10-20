import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  WasmtimeSandboxManager,
  SUPPORTED_MATRIX,
  isPlatformSupported,
  getPlatformTarget,
  simulateDeterministicContract,
} from '../../src/sandbox/wasmtime-addon';

describe('Wasmtime Native Sandbox Addon (#1295)', () => {
  const originalEnv = process.env.ENABLE_WASMTIME_SANDBOX;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ENABLE_WASMTIME_SANDBOX = originalEnv;
    } else {
      delete process.env.ENABLE_WASMTIME_SANDBOX;
    }
  });

  describe('Documented OS/Architecture Matrix', () => {
    it('defines the documented 6-target matrix for x86-64 and ARM64 on Linux, macOS, and Windows', () => {
      expect(SUPPORTED_MATRIX).toHaveLength(6);

      const winX64 = getPlatformTarget('win32', 'x64');
      const winArm64 = getPlatformTarget('win32', 'arm64');
      const linuxX64 = getPlatformTarget('linux', 'x64');
      const linuxArm64 = getPlatformTarget('linux', 'arm64');
      const macX64 = getPlatformTarget('darwin', 'x64');
      const macArm64 = getPlatformTarget('darwin', 'arm64');

      expect(winX64?.artifactName).toBe('wasmtime-sandbox.win32-x64-msvc.node');
      expect(winArm64?.artifactName).toBe('wasmtime-sandbox.win32-arm64-msvc.node');
      expect(linuxX64?.artifactName).toBe('wasmtime-sandbox.linux-x64-gnu.node');
      expect(linuxArm64?.artifactName).toBe('wasmtime-sandbox.linux-arm64-gnu.node');
      expect(macX64?.artifactName).toBe('wasmtime-sandbox.darwin-x64.node');
      expect(macArm64?.artifactName).toBe('wasmtime-sandbox.darwin-arm64.node');
    });

    it('identifies supported platforms correctly', () => {
      expect(isPlatformSupported('win32', 'x64')).toBe(true);
      expect(isPlatformSupported('darwin', 'arm64')).toBe(true);
      expect(isPlatformSupported('linux', 'x64')).toBe(true);
    });
  });

  describe('Unsupported Platforms Capability State & Safe Fallback', () => {
    it('reports an explicit capability state and falls back to simulator for unsupported OS', () => {
      const manager = new WasmtimeSandboxManager({ platform: 'freebsd', arch: 'x64' });
      const state = manager.getCapabilityState();

      expect(state.supported).toBe(false);
      expect(state.tier).toBe('simulator_fallback');
      expect(state.activeRuntime).toBe('js_simulator');
      expect(state.addonLoaded).toBe(false);
      expect(state.selfCheckPassed).toBe(false);
      expect(state.reason).toContain('is not in the documented supported OS/architecture matrix');

      // Execution proceeds via simulator fallback
      const result = manager.execute(new Uint8Array([0, 97, 115, 109]), 'add', [10, 20], 1000);
      expect(result.status).toBe('success');
      expect(result.result).toBe(30);
      expect(result.tier).toBe('simulator_fallback');
    });

    it('reports an explicit capability state for unsupported 32-bit architecture', () => {
      const manager = new WasmtimeSandboxManager({ platform: 'linux', arch: 'ia32' });
      const state = manager.getCapabilityState();

      expect(state.supported).toBe(false);
      expect(state.tier).toBe('simulator_fallback');
      expect(state.activeRuntime).toBe('js_simulator');
      expect(state.reason).toContain('linux/ia32');
    });
  });

  describe('Feature Gating & Startup Self-Check', () => {
    it('disables native execution by default when feature flag is not set', () => {
      delete process.env.ENABLE_WASMTIME_SANDBOX;

      const manager = new WasmtimeSandboxManager({ platform: 'win32', arch: 'x64' });
      const state = manager.getCapabilityState();

      expect(state.supported).toBe(true);
      expect(state.featureGateEnabled).toBe(false);
      expect(state.activeRuntime).toBe('js_simulator');
      expect(state.tier).toBe('simulator_fallback');
      expect(state.reason).toContain('Native execution is feature-gated');
    });

    it('enables native execution when feature flag is true AND self-check passes', () => {
      process.env.ENABLE_WASMTIME_SANDBOX = 'true';

      const manager = new WasmtimeSandboxManager({ platform: 'win32', arch: 'x64' });
      const state = manager.getCapabilityState();

      expect(state.supported).toBe(true);
      expect(state.featureGateEnabled).toBe(true);
      expect(state.selfCheckPassed).toBe(true);
      expect(state.activeRuntime).toBe('wasmtime_native');
      expect(state.tier).toBe('wasmtime_native');
    });

    it('blocks native execution if startup self-check fails, even when feature flag is enabled', () => {
      process.env.ENABLE_WASMTIME_SANDBOX = 'true';

      const failingAddon = {
        getPlatformInfo: () => ({ platform: 'linux', arch: 'x64', engine: 'wasmtime', version: '0.1.0' }),
        selfCheck: () => ({ passed: false, fuelConsumed: 0, result: 0, error: 'Wasmtime validation trap' }),
        executeDeterministicContract: () => ({ status: 'error', error: 'trap' }),
      };

      const manager = new WasmtimeSandboxManager({ platform: 'linux', arch: 'x64', addon: failingAddon });
      const state = manager.getCapabilityState();

      expect(state.featureGateEnabled).toBe(true);
      expect(state.selfCheckPassed).toBe(false);
      expect(state.activeRuntime).toBe('js_simulator');
      expect(state.tier).toBe('simulator_fallback');
      expect(state.reason).toContain('Startup self-check failed');
    });
  });

  describe('Minimal Deterministic Contract Execution & Fuel Metering', () => {
    it('executes deterministic contract with fuel consumption', () => {
      process.env.ENABLE_WASMTIME_SANDBOX = 'true';
      const manager = new WasmtimeSandboxManager();

      const result = manager.execute(new Uint8Array([0, 97, 115, 109]), 'add', [15, 27], 1000);
      expect(result.status).toBe('success');
      expect(result.result).toBe(42);
      expect(result.fuelConsumed).toBeGreaterThan(0);
      expect(result.tier).toBe('wasmtime_native');
    });

    it('enforces fuel limits and detects out-of-fuel conditions', () => {
      const result = simulateDeterministicContract(new Uint8Array([0, 97, 115, 109]), 'add', [1, 2], 5);
      expect(result.status).toBe('out_of_fuel');
      expect(result.error).toContain('Fuel limit exhausted');
    });

    it('safely falls back to simulator if native execution encounters an unexpected exception', () => {
      process.env.ENABLE_WASMTIME_SANDBOX = 'true';

      const buggyNativeAddon = {
        getPlatformInfo: () => ({ platform: 'win32', arch: 'x64', engine: 'wasmtime', version: '0.1.0' }),
        selfCheck: () => ({ passed: true, fuelConsumed: 15, result: 42 }),
        executeDeterministicContract: () => {
          throw new Error('Native segfault simulation');
        },
      };

      const manager = new WasmtimeSandboxManager({ platform: 'win32', arch: 'x64', addon: buggyNativeAddon });
      const result = manager.execute(new Uint8Array([0, 97, 115, 109]), 'add', [10, 20], 1000);

      expect(result.tier).toBe('simulator_fallback');
      expect(result.status).toBe('success');
      expect(result.result).toBe(30);
      expect(result.error).toContain('safely fell back to simulator');
    });
  });
});
