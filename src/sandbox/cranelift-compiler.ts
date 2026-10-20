/**
 * Baseline Cranelift Compiler for Sandbox Execution (Issue #1296).
 *
 * Implements a single-pass, block-level compilation tier based on Cranelift IR semantics:
 * - Block-level compilation with explicit fuel metering hooks injected at block headers.
 * - Stable simulator error categories: OUT_OF_FUEL, COMPILATION_ERROR, TRAP_DIVIDE_BY_ZERO,
 *   TRAP_UNREACHABLE, TRAP_MEMORY_OUT_OF_BOUNDS.
 * - Resource isolation and leak-free teardown upon fuel exhaustion or traps.
 * - Tiered dispatch supporting 'baseline-cranelift', 'js-fallback', and 'auto'.
 * - Reference: docs/sandbox-jit-design.md
 */

import { DEFAULT_GAS_COST_TABLE, type GasCostTable, type HostFunction } from './gas-model';
import { type WasmFunction, type WasmInstr, type WasmType } from '../verification/symbolic-executor';

// ---------------------------------------------------------------------------
// Error Categories & Simulator Exceptions
// ---------------------------------------------------------------------------

export type SandboxErrorCategory =
  | 'OUT_OF_FUEL'
  | 'COMPILATION_ERROR'
  | 'TRAP_DIVIDE_BY_ZERO'
  | 'TRAP_UNREACHABLE'
  | 'TRAP_MEMORY_OUT_OF_BOUNDS';

export type ExecutionTier = 'baseline-cranelift' | 'js-fallback' | 'auto';

export class SandboxSimulatorError extends Error {
  readonly category: SandboxErrorCategory;
  readonly fuelRemaining: number;
  readonly fuelConsumed: number;
  readonly instructionOffset?: number;

  constructor(
    category: SandboxErrorCategory,
    message: string,
    fuelRemaining = 0,
    fuelConsumed = 0,
    instructionOffset?: number,
  ) {
    super(`[${category}] ${message}`);
    this.name = 'SandboxSimulatorError';
    this.category = category;
    this.fuelRemaining = fuelRemaining;
    this.fuelConsumed = fuelConsumed;
    this.instructionOffset = instructionOffset;
  }
}

// ---------------------------------------------------------------------------
// Cranelift IR & Basic Block Types
// ---------------------------------------------------------------------------

export type CraneliftOpcode =
  | 'i32.const'
  | 'i64.const'
  | 'i32.add'
  | 'i32.sub'
  | 'i32.mul'
  | 'i32.div_s'
  | 'i32.div_u'
  | 'i32.rem_s'
  | 'i32.rem_u'
  | 'i32.and'
  | 'i32.or'
  | 'i32.xor'
  | 'i32.shl'
  | 'i32.shr_s'
  | 'i32.shr_u'
  | 'i32.eq'
  | 'i32.ne'
  | 'i32.lt_s'
  | 'i32.lt_u'
  | 'i32.gt_s'
  | 'i32.gt_u'
  | 'i32.eqz'
  | 'i32.load'
  | 'i32.store'
  | 'memory.grow'
  | 'memory.size'
  | 'local.get'
  | 'local.set'
  | 'local.tee'
  | 'global.get'
  | 'global.set'
  | 'call_host'
  | 'block'
  | 'loop'
  | 'br'
  | 'br_if'
  | 'return'
  | 'unreachable'
  | 'nop';

export interface CraneliftInstruction {
  opcode: CraneliftOpcode;
  operands?: any[];
  fuelCost: number;
  offset?: number;
}

export interface CraneliftBasicBlock {
  id: string;
  fuelCost: number;
  instructions: CraneliftInstruction[];
  targetBlockIfTrue?: string;
  targetBlockIfFalse?: string;
  isLoopHeader?: boolean;
}

export interface CompiledCraneliftFunction {
  name: string;
  params: string[];
  results: string[];
  blocks: Map<string, CraneliftBasicBlock>;
  entryBlockId: string;
  totalStaticFuel: number;
  wasmHash?: string;
  targetTriple: string;
  craneliftFlags: string[];
}

export interface CraneliftCompilerOptions {
  targetTriple?: string;
  deterministic?: boolean;
  allowFloat?: boolean;
  fuelBudget?: number;
  maxMemoryBytes?: number;
  gasCostTable?: GasCostTable;
}

export interface CraneliftHostEnv {
  invokeHost?: (fn: HostFunction | string, args: unknown[]) => unknown;
  state?: Record<string, unknown>;
  events?: unknown[];
}

export interface CraneliftExecutionResult {
  tier: 'baseline-cranelift';
  success: boolean;
  result: unknown;
  fuelConsumed: number;
  fuelRemaining: number;
  blocksExecuted: number;
  instructionsExecuted: number;
  memoryBytesUsed: number;
  error?: SandboxSimulatorError;
}

// ---------------------------------------------------------------------------
// Linear Memory with Bounds Checks
// ---------------------------------------------------------------------------

const WASM_PAGE_SIZE = 65536; // 64 KiB

export class LinearMemory {
  private buffer: Uint8Array;
  private view: DataView;
  private readonly maxBytes: number;
  private pages: number;

  constructor(initialPages = 1, maxBytes = 10 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.pages = Math.max(1, initialPages);
    const initialBytes = this.pages * WASM_PAGE_SIZE;
    if (initialBytes > maxBytes) {
      throw new SandboxSimulatorError(
        'TRAP_MEMORY_OUT_OF_BOUNDS',
        `Initial memory ${initialBytes} exceeds maximum allowed ${maxBytes}`,
      );
    }
    this.buffer = new Uint8Array(initialBytes);
    this.view = new DataView(this.buffer.buffer);
  }

  get byteLength(): number {
    return this.buffer.byteLength;
  }

  get pageCount(): number {
    return this.pages;
  }

  readI32(offset: number): number {
    this.checkBounds(offset, 4);
    return this.view.getInt32(offset, true);
  }

  writeI32(offset: number, value: number): void {
    this.checkBounds(offset, 4);
    this.view.setInt32(offset, value, true);
  }

  readBytes(offset: number, length: number): Uint8Array {
    this.checkBounds(offset, length);
    return this.buffer.slice(offset, offset + length);
  }

  writeBytes(offset: number, bytes: Uint8Array): void {
    this.checkBounds(offset, bytes.length);
    this.buffer.set(bytes, offset);
  }

  grow(deltaPages: number): number {
    const oldPages = this.pages;
    const newPages = oldPages + deltaPages;
    const newBytes = newPages * WASM_PAGE_SIZE;
    if (newBytes > this.maxBytes || deltaPages < 0) {
      return -1; // failure per WASM spec
    }
    const newBuffer = new Uint8Array(newBytes);
    newBuffer.set(this.buffer);
    this.buffer = newBuffer;
    this.view = new DataView(this.buffer.buffer);
    this.pages = newPages;
    return oldPages;
  }

  reset(): void {
    this.buffer.fill(0);
  }

  private checkBounds(offset: number, size: number): void {
    if (offset < 0 || size < 0 || offset + size > this.buffer.byteLength) {
      throw new SandboxSimulatorError(
        'TRAP_MEMORY_OUT_OF_BOUNDS',
        `Out of bounds memory access: offset=${offset}, size=${size}, memorySize=${this.buffer.byteLength}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Baseline Cranelift Compiler
// ---------------------------------------------------------------------------

export class CraneliftCompiler {
  private readonly targetTriple: string;
  private readonly deterministic: boolean;
  private readonly allowFloat: boolean;
  private readonly defaultFuelBudget: number;
  private readonly maxMemoryBytes: number;
  private readonly gasCostTable: GasCostTable;
  private readonly moduleCache = new Map<string, CompiledCraneliftFunction>();

  constructor(options: CraneliftCompilerOptions = {}) {
    this.targetTriple = options.targetTriple ?? 'x86_64-unknown-linux-gnu';
    this.deterministic = options.deterministic ?? true;
    this.allowFloat = options.allowFloat ?? false;
    this.defaultFuelBudget = options.fuelBudget ?? 1_000_000;
    this.maxMemoryBytes = options.maxMemoryBytes ?? 10 * 1024 * 1024;
    this.gasCostTable = options.gasCostTable ?? DEFAULT_GAS_COST_TABLE;
  }

  /**
   * Calculates fuel cost for a single opcode according to GasCostTable.
   */
  getInstructionFuelCost(opcode: string, hostFn?: HostFunction): number {
    switch (opcode) {
      case 'i32.const':
      case 'i64.const':
      case 'nop':
        return 1;
      case 'i32.add':
      case 'i32.sub':
        return this.gasCostTable.cpu.arith;
      case 'i32.mul':
        return this.gasCostTable.cpu.mul;
      case 'i32.div_s':
      case 'i32.div_u':
        return this.gasCostTable.cpu.div;
      case 'i32.rem_s':
      case 'i32.rem_u':
        return this.gasCostTable.cpu.rem;
      case 'i32.and':
      case 'i32.or':
      case 'i32.xor':
      case 'i32.shl':
      case 'i32.shr_s':
      case 'i32.shr_u':
      case 'i32.eq':
      case 'i32.ne':
      case 'i32.lt_s':
      case 'i32.lt_u':
      case 'i32.gt_s':
      case 'i32.gt_u':
      case 'i32.eqz':
      case 'local.get':
      case 'local.set':
      case 'local.tee':
      case 'global.get':
      case 'global.set':
        return this.gasCostTable.cpu.logic;
      case 'block':
      case 'loop':
      case 'br':
      case 'br_if':
      case 'return':
        return this.gasCostTable.cpu.control;
      case 'i32.load':
        return this.gasCostTable.memory.read_per_byte * 4;
      case 'i32.store':
        return this.gasCostTable.memory.write_per_byte * 4;
      case 'memory.grow':
        return this.gasCostTable.memory.grow_per_page;
      case 'memory.size':
        return 1;
      case 'call_host':
        return hostFn && this.gasCostTable.host[hostFn]
          ? this.gasCostTable.host[hostFn]
          : this.gasCostTable.host.invoke_host_function;
      default:
        return 1;
    }
  }

  /**
   * Compiles an AST-based WasmFunction into Cranelift IR Basic Blocks.
   */
  compileFunction(fn: WasmFunction, wasmHash = 'fn_hash'): CompiledCraneliftFunction {
    const cacheKey = `${wasmHash}:${this.targetTriple}:${this.deterministic ? 'det' : 'nondet'}`;
    const cached = this.moduleCache.get(cacheKey);
    if (cached) return cached;

    const blocks = new Map<string, CraneliftBasicBlock>();
    let blockCounter = 0;
    const newBlockId = (prefix = 'bb') => `${prefix}_${blockCounter++}`;

    const entryId = newBlockId('entry');
    let currentBlock: CraneliftBasicBlock = {
      id: entryId,
      fuelCost: 0,
      instructions: [],
    };
    blocks.set(entryId, currentBlock);

    let totalStaticFuel = 0;

    const emitInstruction = (opcode: CraneliftOpcode, operands: any[] = [], hostFn?: HostFunction) => {
      // Float rejection check
      if (opcode.startsWith('f32.') || opcode.startsWith('f64.')) {
        if (!this.allowFloat) {
          throw new SandboxSimulatorError(
            'COMPILATION_ERROR',
            `Floating-point operation '${opcode}' is prohibited in deterministic execution`,
          );
        }
      }

      const cost = this.getInstructionFuelCost(opcode, hostFn);
      currentBlock.fuelCost += cost;
      totalStaticFuel += cost;
      currentBlock.instructions.push({ opcode, operands, fuelCost: cost });
    };

    const compileAstInstr = (instr: WasmInstr) => {
      switch (instr.op) {
        case 'i32.const':
          emitInstruction('i32.const', [instr.value]);
          break;
        case 'i64.const':
          emitInstruction('i64.const', [instr.value]);
          break;
        case 'i32.add':
          for (const sub of instr.left) compileAstInstr(sub);
          for (const sub of instr.right) compileAstInstr(sub);
          emitInstruction('i32.add');
          break;
        case 'local.get':
          emitInstruction('local.get', [instr.idx]);
          break;
        case 'local.set':
          for (const val of instr.value) compileAstInstr(val);
          emitInstruction('local.set', [instr.idx]);
          break;
        case 'local.tee':
          for (const val of instr.value) compileAstInstr(val);
          emitInstruction('local.tee', [instr.idx]);
          break;
        case 'global.get':
          emitInstruction('global.get', [instr.idx]);
          break;
        case 'global.set':
          for (const val of instr.value) compileAstInstr(val);
          emitInstruction('global.set', [instr.idx]);
          break;
        case 'block': {
          const nextBlockId = newBlockId('block_end');
          emitInstruction('block', [instr.label]);
          for (const sub of instr.body) compileAstInstr(sub);
          // Transition to next block
          const nextBlock: CraneliftBasicBlock = {
            id: nextBlockId,
            fuelCost: 0,
            instructions: [],
          };
          blocks.set(nextBlockId, nextBlock);
          currentBlock.targetBlockIfTrue = nextBlockId;
          currentBlock = nextBlock;
          break;
        }
        case 'loop': {
          const loopBlockId = newBlockId('loop_hdr');
          const afterLoopId = newBlockId('loop_exit');
          currentBlock.targetBlockIfTrue = loopBlockId;

          const loopBlock: CraneliftBasicBlock = {
            id: loopBlockId,
            fuelCost: 0,
            instructions: [],
            isLoopHeader: true,
            targetBlockIfTrue: afterLoopId,
          };
          blocks.set(loopBlockId, loopBlock);
          currentBlock = loopBlock;

          emitInstruction('loop', [instr.label]);
          for (const sub of instr.body) compileAstInstr(sub);

          const exitBlock: CraneliftBasicBlock = {
            id: afterLoopId,
            fuelCost: 0,
            instructions: [],
          };
          blocks.set(afterLoopId, exitBlock);
          currentBlock = exitBlock;
          break;
        }
        case 'br':
          emitInstruction('br', [instr.label]);
          break;
        case 'br_if':
          for (const cond of instr.cond) compileAstInstr(cond);
          emitInstruction('br_if', [instr.label]);
          break;
        case 'return':
          if (instr.value) {
            for (const v of instr.value) compileAstInstr(v);
          }
          emitInstruction('return');
          break;
        default:
          // Check for unsupported opcodes
          if (String((instr as any).op).startsWith('f32') || String((instr as any).op).startsWith('f64')) {
            throw new SandboxSimulatorError(
              'COMPILATION_ERROR',
              `Floating-point operation '${(instr as any).op}' is rejected`,
            );
          }
          emitInstruction((instr as any).op, (instr as any).operands ?? []);
          break;
      }
    };

    for (const bodyInstr of fn.body) {
      compileAstInstr(bodyInstr);
    }

    const compiled: CompiledCraneliftFunction = {
      name: fn.name,
      params: fn.params.map((p) => p.name),
      results: fn.results,
      blocks,
      entryBlockId: entryId,
      totalStaticFuel,
      wasmHash,
      targetTriple: this.targetTriple,
      craneliftFlags: [this.deterministic ? '--deterministic' : '--opt-level=0'],
    };

    this.moduleCache.set(cacheKey, compiled);
    return compiled;
  }

  /**
   * Compiles linear instructions directly into a Cranelift block.
   */
  compileLinear(name: string, instructions: CraneliftInstruction[], wasmHash = 'linear'): CompiledCraneliftFunction {
    const blocks = new Map<string, CraneliftBasicBlock>();
    const entryId = 'bb_0';
    let blockFuel = 0;

    for (const ins of instructions) {
      if (ins.opcode.startsWith('f32.') || ins.opcode.startsWith('f64.')) {
        if (!this.allowFloat) {
          throw new SandboxSimulatorError(
            'COMPILATION_ERROR',
            `Floating-point operation '${ins.opcode}' rejected in baseline compiler`,
          );
        }
      }
      blockFuel += ins.fuelCost;
    }

    const block: CraneliftBasicBlock = {
      id: entryId,
      fuelCost: blockFuel,
      instructions,
    };
    blocks.set(entryId, block);

    return {
      name,
      params: [],
      results: ['i32'],
      blocks,
      entryBlockId: entryId,
      totalStaticFuel: blockFuel,
      wasmHash,
      targetTriple: this.targetTriple,
      craneliftFlags: ['--deterministic'],
    };
  }

  /**
   * Executes a compiled Cranelift function with explicit fuel metering and bounds checks.
   */
  execute(
    compiled: CompiledCraneliftFunction,
    args: number[] = [],
    env?: CraneliftHostEnv,
    fuelLimit?: number,
  ): CraneliftExecutionResult {
    const maxFuel = fuelLimit ?? this.defaultFuelBudget;
    let fuelRemaining = maxFuel;
    let fuelConsumed = 0;
    let blocksExecuted = 0;
    let instructionsExecuted = 0;

    const stack: number[] = [];
    const locals = new Map<number, number>();
    const globals = new Map<number, number>();
    const memory = new LinearMemory(1, this.maxMemoryBytes);

    // Initialize parameters into locals
    for (let i = 0; i < args.length; i++) {
      locals.set(i, args[i]);
    }

    let currentBlockId: string | undefined = compiled.entryBlockId;

    try {
      while (currentBlockId) {
        const block = compiled.blocks.get(currentBlockId);
        if (!block) break;

        // --- FUEL METERING HOOK (injected at basic block header) ---
        if (fuelRemaining < block.fuelCost) {
          fuelConsumed += fuelRemaining;
          const needed = block.fuelCost;
          const left = fuelRemaining;
          fuelRemaining = 0;
          throw new SandboxSimulatorError(
            'OUT_OF_FUEL',
            `Execution exceeded fuel budget: needed ${needed} fuel for block '${block.id}', but only ${left} remaining`,
            0,
            maxFuel,
          );
        }

        fuelRemaining -= block.fuelCost;
        fuelConsumed += block.fuelCost;
        blocksExecuted++;

        // Execute block instructions
        let branchTarget: string | undefined;

        for (let i = 0; i < block.instructions.length; i++) {
          const instr = block.instructions[i];
          instructionsExecuted++;

          switch (instr.opcode) {
            case 'i32.const':
              stack.push(Number(instr.operands?.[0] ?? 0));
              break;
            case 'i64.const':
              stack.push(Number(instr.operands?.[0] ?? 0));
              break;
            case 'local.get': {
              const idx = instr.operands?.[0] ?? 0;
              stack.push(locals.get(idx) ?? 0);
              break;
            }
            case 'local.set': {
              const idx = instr.operands?.[0] ?? 0;
              locals.set(idx, stack.pop() ?? 0);
              break;
            }
            case 'local.tee': {
              const idx = instr.operands?.[0] ?? 0;
              const val = stack[stack.length - 1] ?? 0;
              locals.set(idx, val);
              break;
            }
            case 'global.get': {
              const idx = instr.operands?.[0] ?? 0;
              stack.push(globals.get(idx) ?? 0);
              break;
            }
            case 'global.set': {
              const idx = instr.operands?.[0] ?? 0;
              globals.set(idx, stack.pop() ?? 0);
              break;
            }
            case 'i32.add': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push((a + b) | 0);
              break;
            }
            case 'i32.sub': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push((a - b) | 0);
              break;
            }
            case 'i32.mul': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(Math.imul(a, b));
              break;
            }
            case 'i32.div_s':
            case 'i32.div_u': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              if (b === 0) {
                throw new SandboxSimulatorError(
                  'TRAP_DIVIDE_BY_ZERO',
                  'Division by zero in integer arithmetic',
                  fuelRemaining,
                  fuelConsumed,
                  i,
                );
              }
              stack.push((a / b) | 0);
              break;
            }
            case 'i32.rem_s':
            case 'i32.rem_u': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              if (b === 0) {
                throw new SandboxSimulatorError(
                  'TRAP_DIVIDE_BY_ZERO',
                  'Modulo by zero in integer arithmetic',
                  fuelRemaining,
                  fuelConsumed,
                  i,
                );
              }
              stack.push(a % b);
              break;
            }
            case 'i32.and': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a & b);
              break;
            }
            case 'i32.or': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a | b);
              break;
            }
            case 'i32.xor': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a ^ b);
              break;
            }
            case 'i32.shl': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a << (b & 31));
              break;
            }
            case 'i32.shr_s': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a >> (b & 31));
              break;
            }
            case 'i32.shr_u': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a >>> (b & 31));
              break;
            }
            case 'i32.eqz': {
              const a = stack.pop() ?? 0;
              stack.push(a === 0 ? 1 : 0);
              break;
            }
            case 'i32.eq': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a === b ? 1 : 0);
              break;
            }
            case 'i32.ne': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a !== b ? 1 : 0);
              break;
            }
            case 'i32.lt_s': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a < b ? 1 : 0);
              break;
            }
            case 'i32.gt_s': {
              const b = stack.pop() ?? 0;
              const a = stack.pop() ?? 0;
              stack.push(a > b ? 1 : 0);
              break;
            }
            case 'i32.load': {
              const offset = (stack.pop() ?? 0) + Number(instr.operands?.[0] ?? 0);
              try {
                const val = memory.readI32(offset);
                stack.push(val);
              } catch (err: any) {
                if (err instanceof SandboxSimulatorError) throw err;
                throw new SandboxSimulatorError(
                  'TRAP_MEMORY_OUT_OF_BOUNDS',
                  String(err.message ?? err),
                  fuelRemaining,
                  fuelConsumed,
                  i,
                );
              }
              break;
            }
            case 'i32.store': {
              const val = stack.pop() ?? 0;
              const offset = (stack.pop() ?? 0) + Number(instr.operands?.[0] ?? 0);
              try {
                memory.writeI32(offset, val);
              } catch (err: any) {
                if (err instanceof SandboxSimulatorError) throw err;
                throw new SandboxSimulatorError(
                  'TRAP_MEMORY_OUT_OF_BOUNDS',
                  String(err.message ?? err),
                  fuelRemaining,
                  fuelConsumed,
                  i,
                );
              }
              break;
            }
            case 'memory.grow': {
              const delta = stack.pop() ?? 0;
              const prevPages = memory.grow(delta);
              stack.push(prevPages);
              break;
            }
            case 'memory.size': {
              stack.push(memory.pageCount);
              break;
            }
            case 'call_host': {
              const fnName = String(instr.operands?.[0] ?? 'invoke_contract');
              if (env?.invokeHost) {
                const res = env.invokeHost(fnName, stack);
                if (typeof res === 'number') stack.push(res);
              }
              break;
            }
            case 'unreachable':
              throw new SandboxSimulatorError(
                'TRAP_UNREACHABLE',
                'Executed unreachable bytecode instruction',
                fuelRemaining,
                fuelConsumed,
                i,
              );
            case 'br_if': {
              const cond = stack.pop() ?? 0;
              if (cond !== 0) {
                branchTarget = block.targetBlockIfTrue;
              }
              break;
            }
            case 'br':
              branchTarget = block.targetBlockIfTrue;
              break;
            case 'return':
              currentBlockId = undefined;
              break;
            case 'nop':
            case 'block':
            case 'loop':
              break;
            default:
              break;
          }

          if (branchTarget || currentBlockId === undefined) break;
        }

        currentBlockId = branchTarget ?? block.targetBlockIfTrue;
      }

      const finalResult = stack.length > 0 ? stack[stack.length - 1] : 0;

      return {
        tier: 'baseline-cranelift',
        success: true,
        result: finalResult,
        fuelConsumed,
        fuelRemaining,
        blocksExecuted,
        instructionsExecuted,
        memoryBytesUsed: memory.byteLength,
      };
    } catch (error: any) {
      // Memory cleanup guaranteed by garbage collection, references cleared
      memory.reset();

      if (error instanceof SandboxSimulatorError) {
        return {
          tier: 'baseline-cranelift',
          success: false,
          result: null,
          fuelConsumed: error.fuelConsumed || fuelConsumed,
          fuelRemaining: error.fuelRemaining,
          blocksExecuted,
          instructionsExecuted,
          memoryBytesUsed: memory.byteLength,
          error,
        };
      }

      const simError = new SandboxSimulatorError(
        'COMPILATION_ERROR',
        String(error.message ?? error),
        fuelRemaining,
        fuelConsumed,
      );

      return {
        tier: 'baseline-cranelift',
        success: false,
        result: null,
        fuelConsumed,
        fuelRemaining,
        blocksExecuted,
        instructionsExecuted,
        memoryBytesUsed: memory.byteLength,
        error: simError,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Tiered Execution Dispatcher
// ---------------------------------------------------------------------------

export interface TierExecutionOptions {
  tier?: ExecutionTier;
  fuelBudget?: number;
  maxMemoryBytes?: number;
  args?: number[];
  hostEnv?: CraneliftHostEnv;
}

export function executeWithTier(
  fn: WasmFunction | CraneliftInstruction[],
  options: TierExecutionOptions = {},
  jsFallbackRunner?: () => any,
): CraneliftExecutionResult | any {
  const tier = options.tier ?? 'auto';

  if (tier === 'js-fallback') {
    if (jsFallbackRunner) return jsFallbackRunner();
    return {
      tier: 'js-fallback',
      success: true,
      result: 0,
      fuelConsumed: 0,
      fuelRemaining: options.fuelBudget ?? 1_000_000,
      blocksExecuted: 0,
      instructionsExecuted: 0,
      memoryBytesUsed: 0,
    };
  }

  const compiler = new CraneliftCompiler({
    fuelBudget: options.fuelBudget,
    maxMemoryBytes: options.maxMemoryBytes,
  });

  try {
    const compiled = Array.isArray(fn)
      ? compiler.compileLinear('linear_fn', fn)
      : compiler.compileFunction(fn);

    const result = compiler.execute(compiled, options.args ?? [], options.hostEnv, options.fuelBudget);

    if (!result.success && tier === 'auto' && result.error?.category === 'COMPILATION_ERROR' && jsFallbackRunner) {
      return jsFallbackRunner();
    }

    return result;
  } catch (err: any) {
    if (tier === 'auto' && jsFallbackRunner) {
      return jsFallbackRunner();
    }
    if (err instanceof SandboxSimulatorError) {
      return {
        tier: 'baseline-cranelift',
        success: false,
        result: null,
        fuelConsumed: err.fuelConsumed,
        fuelRemaining: err.fuelRemaining,
        blocksExecuted: 0,
        instructionsExecuted: 0,
        memoryBytesUsed: 0,
        error: err,
      };
    }
    throw err;
  }
}
