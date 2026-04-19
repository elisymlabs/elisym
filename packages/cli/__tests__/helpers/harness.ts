import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { JobLedger } from '../../src/ledger.js';
import { AgentRuntime, type RuntimeConfig } from '../../src/runtime.js';
import type { SkillRegistry, Skill } from '../../src/skill';
import { makeFakeTransport, type FakeTransport } from './fakeTransport.js';

export const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function freeConfig(): RuntimeConfig {
  return {
    paymentTimeoutSecs: 30,
    maxConcurrentJobs: 2,
    recoveryMaxRetries: 3,
    recoveryIntervalSecs: 999,
    network: 'devnet',
  };
}

export function makeFakeSkill(result: string): Skill {
  return {
    name: 'integration-skill',
    description: 'integration skill',
    capabilities: ['text-gen'],
    priceLamports: 0,
    execute: vi.fn().mockResolvedValue({ data: result }),
  };
}

export function makeFakeRegistry(skill: Skill): SkillRegistry {
  return {
    register: vi.fn(),
    route: vi.fn().mockReturnValue(skill),
    allCapabilities: vi.fn().mockReturnValue(['text-gen']),
    all: vi.fn().mockReturnValue([skill]),
    isEmpty: vi.fn().mockReturnValue(false),
  } as unknown as SkillRegistry;
}

export interface CrashHarness {
  agentDir: string;
  ledger: JobLedger;
  transport: FakeTransport;
  runtime: AgentRuntime;
  skill: Skill;
  cleanup(): void;
}

export interface CrashHarnessOptions {
  skillResult?: string;
  config?: Partial<RuntimeConfig>;
}

/**
 * Build a runtime + ledger + fake transport in a tmp agent dir. The
 * caller seeds the ledger with a crash-scenario entry before calling
 * `runtime.run()`, then calls `cleanup()` in afterEach.
 */
export function createCrashHarness(options: CrashHarnessOptions = {}): CrashHarness {
  const agentDir = mkdtempSync(join(tmpdir(), 'elisym-cli-integration-'));
  const ledger = new JobLedger(join(agentDir, '.jobs.json'));
  const transport = makeFakeTransport();
  const skill = makeFakeSkill(options.skillResult ?? 'integration result');
  const registry = makeFakeRegistry(skill);
  const runtime = new AgentRuntime(
    transport.transport,
    registry,
    { llm: null as unknown as Skill['execute'], agentName: 'test', agentDescription: '' },
    { ...freeConfig(), ...options.config },
    ledger,
    { onLog: vi.fn() },
  );
  return {
    agentDir,
    ledger,
    transport,
    runtime,
    skill,
    cleanup(): void {
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}
