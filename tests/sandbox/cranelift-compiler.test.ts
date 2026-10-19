import { describe, it, expect } from 'vitest';
import {
  CraneliftCompiler,
  LinearMemory,
  SandboxSimulatorError,
  executeWithTier,
  type CraneliftInstruction,
} from '../../src/sandbox/cranelift-compiler';
import { type WasmFunction } from '../../src/verification/symbolic-executor';

describe('Cranelift Baseline Compiler (Issue #1296)', () => {
  describe('Linear Memory', () => {
    it('initializes memory with 64 KiB pages and enforces bounds', () => {
      const memory = new LinearMemory(1, 10 * 1024 * 1024);
      expect(memory.byteLength).toBe(65536);
      expect(memory.pageCount).toBe(1);

      // In-bounds read and write
      memory.writeI32(100, 42);
      expect(memory.readI32(100)).toBe(42);

      // Out-of-bounds read triggers TRAP_MEMORY_OUT_OF_BOUNDS
      expect(() => memory.readI32(70000)).toThrow(SandboxSimulatorError);
      try {
        memory.readI32(70000);
      } catch (err: any) {
        expect(err.category).toBe('TRAP_MEMORY_OUT_OF_BOUNDS');
      }

      // Out-of-bounds write triggers TRAP_MEMORY_OUT_OF_BOUNDS
      expect(() => memory.writeI32(-4, 10)).toThrow(SandboxSimulatorError);
    });

    it('grows memory by pages up to maxMemoryBytes', () => {
      const memory = new LinearMemory(1, 196608); // 3 pages max
      const oldPages = memory.grow(1);
      expect(oldPages).toBe(1);
      expect(memory.pageCount).toBe(2);

      // Exceeding maxMemoryBytes returns -1
      const failPages = memory.grow(5);
      expect(failPages).toBe(-1);
    });
  });

  describe('Compilation and Execution', () => {
    it('compiles and executes linear arithmetic instructions', () => {
      const compiler = new CraneliftCompiler({ fuelBudget: 1000 });
      const instructions: CraneliftInstruction[] = [
        { opcode: 'i32.const', operands: [25], fuelCost: 1 },
        { opcode: 'i32.const', operands: [17], fuelCost: 1 },
        { opcode: 'i32.add', fuelCost: 1 },
        { opcode: 'return', fuelCost: 2 },
      ];

      const compiled = compiler.compileLinear('add_test', instructions);
      expect(compiled.blocks.size).toBe(1);
      expect(compiled.totalStaticFuel).toBe(5);

      const result = compiler.execute(compiled);
      expect(result.success).toBe(true);
      expect(result.result).toBe(42);
      expect(result.fuelConsumed).toBe(5);
      expect(result.fuelRemaining).toBe(995);
      expect(result.blocksExecuted).toBe(1);
      expect(result.tier).toBe('baseline-cranelift');
    });

    it('compiles AST WasmFunction with arguments and locals', () => {
      const compiler = new CraneliftCompiler({ fuelBudget: 1000 });
      const fn: WasmFunction = {
        name: 'sum_and_mul',
        params: [
          { name: 'a', type: 'i32' },
          { name: 'b', type: 'i32' },
        ],
        results: ['i32'],
        body: [
          { op: 'local.get', idx: 0 },
          { op: 'local.get', idx: 1 },
          {
            op: 'i32.add',
            left: [{ op: 'local.get', idx: 0 }],
            right: [{ op: 'local.get', idx: 1 }],
          },
          { op: 'return' },
        ],
      };

      const compiled = compiler.compileFunction(fn);
      expect(compiled.name).toBe('sum_and_mul');

      const result = compiler.execute(compiled, [15, 27]);
      expect(result.success).toBe(true);
      expect(result.result).toBe(42);
      expect(result.instructionsExecuted).toBeGreaterThan(0);
    });
  });

  describe('Fuel Metering and Resource Isolation', () => {
    it('terminates with OUT_OF_FUEL when block fuel cost exceeds remaining budget', () => {
      const compiler = new CraneliftCompiler({ fuelBudget: 2 });
      const instructions: CraneliftInstruction[] = [
        { opcode: 'i32.const', operands: [10], fuelCost: 1 },
        { opcode: 'i32.const', operands: [20], fuelCost: 1 },
        { opcode: 'i32.add', fuelCost: 1 }, // total block cost = 3 > budget 2
        { opcode: 'return', fuelCost: 2 },
      ];

      const compiled = compiler.compileLinear('fuel_exhaustion', instructions);
      const result = compiler.execute(compiled);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.category).toBe('OUT_OF_FUEL');
      expect(result.error?.message).toContain('OUT_OF_FUEL');
      expect(result.fuelRemaining).toBe(0);
    });
  });

  describe('Stable Error Categories', () => {
    it('traps on integer division by zero with TRAP_DIVIDE_BY_ZERO', () => {
      const compiler = new CraneliftCompiler();
      const instructions: CraneliftInstruction[] = [
        { opcode: 'i32.const', operands: [100], fuelCost: 1 },
        { opcode: 'i32.const', operands: [0], fuelCost: 1 },
        { opcode: 'i32.div_s', fuelCost: 5 },
      ];

      const compiled = compiler.compileLinear('div_zero', instructions);
      const result = compiler.execute(compiled);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('TRAP_DIVIDE_BY_ZERO');
    });

    it('traps on unreachable instruction with TRAP_UNREACHABLE', () => {
      const compiler = new CraneliftCompiler();
      const instructions: CraneliftInstruction[] = [{ opcode: 'unreachable', fuelCost: 1 }];

      const compiled = compiler.compileLinear('unreachable_test', instructions);
      const result = compiler.execute(compiled);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('TRAP_UNREACHABLE');
    });

    it('traps on out of bounds linear memory access with TRAP_MEMORY_OUT_OF_BOUNDS', () => {
      const compiler = new CraneliftCompiler();
      const instructions: CraneliftInstruction[] = [
        { opcode: 'i32.const', operands: [9999999], fuelCost: 1 }, // exceeds 64KB initial page
        { opcode: 'i32.load', operands: [0], fuelCost: 4 },
      ];

      const compiled = compiler.compileLinear('oob_test', instructions);
      const result = compiler.execute(compiled);

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('TRAP_MEMORY_OUT_OF_BOUNDS');
    });

    it('rejects floating-point operations with COMPILATION_ERROR per deterministic spec', () => {
      const compiler = new CraneliftCompiler({ allowFloat: false });
      const instructions: CraneliftInstruction[] = [
        { opcode: 'f32.add' as any, fuelCost: 1 },
      ];

      expect(() => compiler.compileLinear('float_test', instructions)).toThrow(SandboxSimulatorError);
      try {
        compiler.compileLinear('float_test', instructions);
      } catch (err: any) {
        expect(err.category).toBe('COMPILATION_ERROR');
        expect(err.message).toContain('Floating-point');
      }
    });
  });

  describe('Tier Dispatcher & Fallback', () => {
    it('executes baseline-cranelift tier directly', () => {
      const instructions: CraneliftInstruction[] = [
        { opcode: 'i32.const', operands: [50], fuelCost: 1 },
        { opcode: 'return', fuelCost: 2 },
      ];

      const result = executeWithTier(instructions, { tier: 'baseline-cranelift' });
      expect(result.tier).toBe('baseline-cranelift');
      expect(result.success).toBe(true);
      expect(result.result).toBe(50);
    });

    it('executes js-fallback tier when requested', () => {
      const instructions: CraneliftInstruction[] = [
        { opcode: 'i32.const', operands: [100], fuelCost: 1 },
      ];

      const result = executeWithTier(
        instructions,
        { tier: 'js-fallback' },
        () => ({ tier: 'js-fallback', success: true, result: 999 }),
      );

      expect(result.tier).toBe('js-fallback');
      expect(result.result).toBe(999);
    });

    it('falls back to js-fallback in auto mode if compiler encounters compilation error', () => {
      const badInstructions: CraneliftInstruction[] = [
        { opcode: 'f32.add' as any, fuelCost: 1 },
      ];

      const result = executeWithTier(
        badInstructions,
        { tier: 'auto' },
        () => ({ tier: 'js-fallback', success: true, result: 1234 }),
      );

      expect(result.tier).toBe('js-fallback');
      expect(result.result).toBe(1234);
    });
  });
});
