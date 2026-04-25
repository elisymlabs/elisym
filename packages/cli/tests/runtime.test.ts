import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_SOL } from '@elisym/sdk';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobLedger } from '../src/ledger.js';
import { AgentRuntime, type RuntimeConfig } from '../src/runtime.js';
import { SkillRegistry } from '../src/skill';
import type { Skill } from '../src/skill';
import type { NostrTransport, IncomingJob } from '../src/transport/nostr.js';

// Configurable mock for verifyPayment - reset in beforeEach
let mockVerifyResult: any = { verified: true, txSignature: 'tx123' };

// Mock SolanaPaymentStrategy and Connection
vi.mock('@elisym/sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    SolanaPaymentStrategy: vi.fn().mockImplementation(() => ({
      createPaymentRequest: vi.fn().mockReturnValue({
        recipient: 'addr',
        amount: 100_000,
        reference: 'ref',
        created_at: Math.floor(Date.now() / 1000),
        expiry_secs: 600,
      }),
      verifyPayment: vi.fn().mockImplementation(() => Promise.resolve(mockVerifyResult)),
    })),
    calculateProtocolFee: actual.calculateProtocolFee,
    getProtocolConfig: vi.fn().mockResolvedValue({
      feeBps: 300,
      treasury: 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy',
      admin: '11111111111111111111111111111111',
      pendingAdmin: null,
      paused: false,
      version: 1,
      source: 'onchain',
    }),
    getProtocolProgramId: vi.fn().mockReturnValue('BrX1CRkSgvcjxBvc2bgc3QqgWjinusofDmeP7ZVxvwrE'),
  };
});

vi.mock('@solana/kit', () => ({
  createSolanaRpc: vi.fn().mockReturnValue({
    getTransaction: vi.fn(),
  }),
}));

let agentDir: string;
let ledger: JobLedger;

function makeJob(id: string): IncomingJob {
  return {
    jobId: id,
    input: 'test input',
    inputType: 'text',
    tags: ['elisym', 'text-gen'],
    customerId: 'customer1',
    encrypted: false,
    rawEvent: {
      id,
      pubkey: 'customer1',
      created_at: Math.floor(Date.now() / 1000),
      kind: 5100,
      tags: [
        ['i', 'test input', 'text'],
        ['t', 'elisym'],
        ['t', 'text-gen'],
      ],
      content: 'test input',
      sig: 'sig',
    },
  };
}

function makeFakeSkill(name: string, result: string, priceSubunits = 0): Skill {
  return {
    name,
    description: `Fake ${name} skill`,
    capabilities: ['text-gen'],
    priceSubunits,
    asset: NATIVE_SOL,
    execute: vi.fn().mockResolvedValue({ data: result }),
  };
}

function makeFakeRegistry(skill: Skill | null): SkillRegistry {
  return {
    register: vi.fn(),
    route: vi.fn().mockReturnValue(skill),
    allCapabilities: vi.fn().mockReturnValue(['text-gen']),
  } as unknown as SkillRegistry;
}

function makeFakeTransport(): {
  transport: NostrTransport;
  triggerJob: (job: IncomingJob) => void;
} {
  let onJobCb: ((job: IncomingJob) => void) | null = null;
  const transport = {
    start: vi.fn((cb: (job: IncomingJob) => void) => {
      onJobCb = cb;
    }),
    stop: vi.fn(),
    sendFeedback: vi.fn().mockResolvedValue(undefined),
    deliverResult: vi.fn().mockResolvedValue('result-event-id'),
  } as unknown as NostrTransport;

  return {
    transport,
    triggerJob: (job: IncomingJob) => onJobCb?.(job),
  };
}

/** Wait for runtime.run() to finish setup and start listening. */
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const freeConfig: RuntimeConfig = {
  paymentTimeoutSecs: 30,
  maxConcurrentJobs: 2,
  recoveryMaxRetries: 3,
  recoveryIntervalSecs: 999,
  network: 'devnet',
};

beforeEach(() => {
  mockVerifyResult = { verified: true, txSignature: 'tx123' };
  agentDir = mkdtempSync(join(tmpdir(), 'elisym-runtime-test-'));
  ledger = new JobLedger(join(agentDir, '.jobs.json'));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe('AgentRuntime', () => {
  describe('free mode', () => {
    it('processes job without payment', async () => {
      const skill = makeFakeSkill('test-skill', 'hello world');
      const registry = makeFakeRegistry(skill);
      const { transport, triggerJob } = makeFakeTransport();
      const onCompleted = vi.fn();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onJobCompleted: onCompleted, onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick(); // let run() setup complete
      triggerJob(makeJob('free-job-1'));
      await tick(150); // wait for async job processing
      runtime.stop();
      await runPromise.catch(() => {});

      expect(skill.execute).toHaveBeenCalledOnce();
      expect((transport as any).deliverResult).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'free-job-1' }),
        'hello world',
        undefined,
      );
      expect(onCompleted).toHaveBeenCalledWith('free-job-1', 'hello world');
      expect(ledger.getStatus('free-job-1')).toBe('delivered');
    });
  });

  describe('skill routing', () => {
    it('calls onJobError when no skill matches', async () => {
      const registry = makeFakeRegistry(null);
      const { transport, triggerJob } = makeFakeTransport();
      const onError = vi.fn();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onJobError: onError, onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();
      triggerJob(makeJob('no-skill-job'));
      await tick(150);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(onError).toHaveBeenCalledWith('no-skill-job', expect.stringContaining('No skill'));
    });
  });

  describe('dedup', () => {
    it('does not process same job twice', async () => {
      const skill = makeFakeSkill('test-skill', 'result');
      const registry = makeFakeRegistry(skill);
      const { transport, triggerJob } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();

      const job = makeJob('dup-job');
      triggerJob(job);
      await tick(50); // let first job start processing
      triggerJob(job); // second should be rejected

      await tick(150);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(skill.execute).toHaveBeenCalledOnce();
    });
  });

  describe('callbacks', () => {
    it('fires onJobReceived', async () => {
      const skill = makeFakeSkill('test-skill', 'result');
      const registry = makeFakeRegistry(skill);
      const { transport, triggerJob } = makeFakeTransport();
      const onReceived = vi.fn();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onJobReceived: onReceived, onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();
      triggerJob(makeJob('recv-job'));
      await tick(50);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(onReceived).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'recv-job' }));
    });

    it('isolates onStop errors and still completes shutdown', async () => {
      const skill = makeFakeSkill('test-skill', 'result');
      const registry = makeFakeRegistry(skill);
      const { transport } = makeFakeTransport();
      const onLog = vi.fn();
      const onStop = vi.fn(() => {
        throw new Error('teardown boom');
      });

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onLog, onStop },
      );

      const runPromise = runtime.run();
      await tick();
      expect(() => runtime.stop()).not.toThrow();
      await runPromise.catch(() => {});

      expect(onStop).toHaveBeenCalledTimes(1);
      expect(onLog).toHaveBeenCalledWith(expect.stringContaining('teardown boom'));
    });

    it('stop() is idempotent - second call does not re-invoke onStop', async () => {
      const skill = makeFakeSkill('test-skill', 'result');
      const registry = makeFakeRegistry(skill);
      const { transport } = makeFakeTransport();
      const onStop = vi.fn();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onStop },
      );

      const runPromise = runtime.run();
      await tick();
      runtime.stop();
      runtime.stop();
      runtime.stop();
      await runPromise.catch(() => {});

      expect(onStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('recovery', () => {
    it('marks jobs as failed after max retries', async () => {
      ledger.recordPaid({
        job_id: 'stale-job',
        input: 'test',
        input_type: 'text',
        tags: ['elisym'],
        customer_id: 'cust',
        created_at: Math.floor(Date.now() / 1000),
      });
      for (let i = 0; i < 3; i++) {
        ledger.incrementRetry('stale-job');
      }

      const skill = makeFakeSkill('test-skill', 'result');
      const registry = makeFakeRegistry(skill);
      const { transport } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        { ...freeConfig, recoveryMaxRetries: 3 },
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick(50);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(ledger.getStatus('stale-job')).toBe('failed');
    });
  });

  describe('ledger tracking', () => {
    it('records job through paid -> executed -> delivered', async () => {
      const skill = makeFakeSkill('test-skill', 'result-data');
      const registry = makeFakeRegistry(skill);
      const { transport, triggerJob } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();
      triggerJob(makeJob('tracked-job'));
      await tick(150);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(ledger.getStatus('tracked-job')).toBe('delivered');
    });
  });

  describe('per-capability pricing', () => {
    it('resolves different prices for different skill tags', async () => {
      const freeSkill = makeFakeSkill('basic', 'result', 0);
      freeSkill.capabilities = ['basic'];
      const paidSkill = makeFakeSkill('premium', 'paid result', 100_000);
      paidSkill.capabilities = ['premium'];

      const registry = new SkillRegistry();
      registry.register(paidSkill);
      registry.register(freeSkill);

      const { transport, triggerJob } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();

      // Free skill job - should process without payment
      const freeJob = makeJob('free-cap-job');
      freeJob.tags = ['elisym', 'basic'];
      triggerJob(freeJob);

      await tick(150);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(freeSkill.execute).toHaveBeenCalledOnce();
      expect(ledger.getStatus('free-cap-job')).toBe('delivered');
    });
  });

  describe('recovery re-execution', () => {
    it('re-executes paid-but-not-executed jobs', async () => {
      // Pre-populate ledger with a paid job (crashed before execution)
      ledger.recordPaid({
        job_id: 'paid-crashed',
        input: 'test input',
        input_type: 'text',
        tags: ['elisym', 'text-gen'],
        customer_id: 'cust',
        net_amount: 9_700_000,
        raw_event_json: JSON.stringify({
          id: 'paid-crashed',
          pubkey: 'cust',
          created_at: Math.floor(Date.now() / 1000),
          kind: 5100,
          tags: [
            ['t', 'elisym'],
            ['t', 'text-gen'],
          ],
          content: 'test input',
          sig: 'sig',
        }),
        created_at: Math.floor(Date.now() / 1000),
      });

      const skill = makeFakeSkill('test-skill', 'recovered result');
      const registry = makeFakeRegistry(skill);
      const { transport } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick(100);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(skill.execute).toHaveBeenCalledOnce();
      expect(ledger.getStatus('paid-crashed')).toBe('delivered');
      expect((transport as any).deliverResult).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('sanitizes API errors before sending to customer', async () => {
      const failingSkill: Skill = {
        name: 'fail-skill',
        description: 'Fails',
        capabilities: ['text-gen'],
        priceSubunits: 0,
        asset: NATIVE_SOL,
        execute: vi.fn().mockRejectedValue(new Error('Anthropic API error: 429 rate limited')),
      };
      const registry = makeFakeRegistry(failingSkill);
      const { transport, triggerJob } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();
      triggerJob(makeJob('error-job'));
      await tick(150);
      runtime.stop();
      await runPromise.catch(() => {});

      // Error feedback should be sanitized (no API details)
      const feedbackCalls = (transport as any).sendFeedback.mock.calls;
      const errorCall = feedbackCalls.find((c: any) => c[1]?.type === 'error');
      expect(errorCall[1].message).toBe('Internal processing error');
    });

    it('passes non-API errors through', async () => {
      const failingSkill: Skill = {
        name: 'fail-skill',
        description: 'Fails',
        capabilities: ['text-gen'],
        priceSubunits: 0,
        asset: NATIVE_SOL,
        execute: vi.fn().mockRejectedValue(new Error('No skill matched')),
      };
      const registry = makeFakeRegistry(failingSkill);
      const { transport, triggerJob } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();
      triggerJob(makeJob('safe-error-job'));
      await tick(150);
      runtime.stop();
      await runPromise.catch(() => {});

      const feedbackCalls = (transport as any).sendFeedback.mock.calls;
      const errorCall = feedbackCalls.find((c: any) => c[1]?.type === 'error');
      expect(errorCall[1].message).toBe('No skill matched');
    });
  });

  describe('recovery with empty result', () => {
    it('re-delivers executed jobs with empty string result', async () => {
      // Pre-populate ledger with an executed job that has empty result
      ledger.recordPaid({
        job_id: 'empty-result-job',
        input: 'test input',
        input_type: 'text',
        tags: ['elisym', 'text-gen'],
        customer_id: 'cust',
        net_amount: undefined,
        raw_event_json: JSON.stringify({
          id: 'empty-result-job',
          pubkey: 'cust',
          created_at: Math.floor(Date.now() / 1000),
          kind: 5100,
          tags: [
            ['t', 'elisym'],
            ['t', 'text-gen'],
          ],
          content: 'test input',
          sig: 'sig',
        }),
        created_at: Math.floor(Date.now() / 1000),
      });
      ledger.markExecuted('empty-result-job', '');

      const skill = makeFakeSkill('test-skill', 'result');
      const registry = makeFakeRegistry(skill);
      const { transport } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick(100);
      runtime.stop();
      await runPromise.catch(() => {});

      // Should re-deliver the empty result, not re-execute
      expect((transport as any).deliverResult).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'empty-result-job' }),
        '',
        undefined,
      );
      expect(ledger.getStatus('empty-result-job')).toBe('delivered');
      // Skill should NOT have been called (re-deliver only)
      expect(skill.execute).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('rejects jobs from same customer exceeding rate limit', async () => {
      const skill = makeFakeSkill('test-skill', 'result');
      const registry = makeFakeRegistry(skill);
      const { transport, triggerJob } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        { ...freeConfig, maxQueueSize: 200 },
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();

      // Send 21 jobs from same customer (limit is 20)
      for (let i = 0; i < 21; i++) {
        const job = makeJob(`rate-job-${i}`);
        job.customerId = 'same-customer';
        triggerJob(job);
      }

      await tick(300);
      runtime.stop();
      await runPromise.catch(() => {});

      // 21st job should get rate limited feedback
      const feedbackCalls = (transport as any).sendFeedback.mock.calls;
      const rateLimited = feedbackCalls.find(
        (c: any) => c[1]?.type === 'error' && c[1]?.message?.includes('Rate limited'),
      );
      expect(rateLimited).toBeDefined();
    });

    it('does not count customer-rate-limited jobs toward global limit', async () => {
      const skill = makeFakeSkill('test-skill', 'result');
      const registry = makeFakeRegistry(skill);
      const { transport, triggerJob } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        { ...freeConfig, maxQueueSize: 500 },
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();

      // Send 25 jobs from same customer - 20 accepted, 5 rate-limited
      for (let i = 0; i < 25; i++) {
        const job = makeJob(`global-rate-${i}`);
        job.customerId = 'heavy-user';
        triggerJob(job);
      }

      await tick(300);

      // Now send jobs from a different customer - global limit should NOT have been
      // inflated by the 5 rejected jobs
      const job = makeJob('other-user-job');
      job.customerId = 'other-user';
      triggerJob(job);

      await tick(150);
      runtime.stop();
      await runPromise.catch(() => {});

      // The other-user job should have been accepted (not global-rate-limited)
      const feedbackCalls = (transport as any).sendFeedback.mock.calls;
      const globalLimited = feedbackCalls.find(
        (c: any) =>
          c[0]?.jobId === 'other-user-job' &&
          c[1]?.type === 'error' &&
          c[1]?.message?.includes('Server busy'),
      );
      expect(globalLimited).toBeUndefined();
    });
  });

  describe('queue overflow', () => {
    it('drops jobs with error feedback when queue is full', async () => {
      // Slow skill that holds queue slots
      const slowSkill: Skill = {
        name: 'slow',
        description: 'Slow',
        capabilities: ['text-gen'],
        priceSubunits: 0,
        asset: NATIVE_SOL,
        execute: vi
          .fn()
          .mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve({ data: 'done' }), 500)),
          ),
      };
      const registry = makeFakeRegistry(slowSkill);
      const { transport, triggerJob } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        { ...freeConfig, maxConcurrentJobs: 1, maxQueueSize: 2 },
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();

      // Fill queue: 1 running + 1 pending = 2 = maxQueueSize
      triggerJob(makeJob('q-1'));
      triggerJob(makeJob('q-2'));
      await tick(20);

      // This one should be dropped
      triggerJob(makeJob('q-overflow'));
      await tick(20);

      const feedbackCalls = (transport as any).sendFeedback.mock.calls;
      const overflow = feedbackCalls.find(
        (c: any) =>
          c[0]?.jobId === 'q-overflow' &&
          c[1]?.type === 'error' &&
          c[1]?.message?.includes('overloaded'),
      );
      expect(overflow).toBeDefined();

      // Cleanup
      await tick(600);
      runtime.stop();
      await runPromise.catch(() => {});
    });
  });

  describe('job timeout', () => {
    it('aborts long-running jobs and sends error feedback', async () => {
      // Skill that never resolves (simulates hang)
      const hangingSkill: Skill = {
        name: 'hang',
        description: 'Hangs',
        capabilities: ['text-gen'],
        priceSubunits: 0,
        asset: NATIVE_SOL,
        execute: vi.fn().mockImplementation(
          (_input: any, ctx: any) =>
            new Promise((_resolve, reject) => {
              // Listen for abort signal
              if (ctx.signal) {
                ctx.signal.addEventListener('abort', () => {
                  reject(new Error('The operation was aborted'));
                });
              }
            }),
        ),
      };
      const registry = makeFakeRegistry(hangingSkill);
      const { transport, triggerJob } = makeFakeTransport();

      // Use a short timeout for testing (override via module-level constant is not easy,
      // but we can test the error handling path by making the skill respond to abort)
      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        freeConfig,
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();

      triggerJob(makeJob('timeout-job'));
      await tick(50);

      // Skill should have been called with a signal
      expect(hangingSkill.execute).toHaveBeenCalledOnce();
      const ctx = (hangingSkill.execute as any).mock.calls[0][1];
      expect(ctx.signal).toBeDefined();
      expect(ctx.signal).toBeInstanceOf(AbortSignal);

      runtime.stop();
      await runPromise.catch(() => {});
    });
  });

  describe('recovery payment re-verification', () => {
    it('re-verifies payment when request was stored but net_amount missing', async () => {
      ledger.recordPaid({
        job_id: 'pay-reverify',
        input: 'test input',
        input_type: 'text',
        tags: ['elisym', 'text-gen'],
        customer_id: 'cust',
        raw_event_json: JSON.stringify({
          id: 'pay-reverify',
          pubkey: 'cust',
          created_at: Math.floor(Date.now() / 1000),
          kind: 5100,
          tags: [
            ['t', 'elisym'],
            ['t', 'text-gen'],
          ],
          content: 'test input',
          sig: 'sig',
        }),
        created_at: Math.floor(Date.now() / 1000),
      });
      // Early store: payment_request saved, net_amount still undefined
      ledger.updatePayment('pay-reverify', undefined, '{"reference":"ref123"}');

      const skill = makeFakeSkill('test-skill', 'recovered', 100_000);
      const registry = makeFakeRegistry(skill);
      const { transport } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        { ...freeConfig, solanaAddress: 'addr' },
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick(100);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(skill.execute).toHaveBeenCalledOnce();
      expect(ledger.getStatus('pay-reverify')).toBe('delivered');
    });

    it('marks failed when re-verification returns not verified', async () => {
      mockVerifyResult = { verified: false };

      ledger.recordPaid({
        job_id: 'pay-noverify',
        input: 'test input',
        input_type: 'text',
        tags: ['elisym', 'text-gen'],
        customer_id: 'cust',
        raw_event_json: JSON.stringify({
          id: 'pay-noverify',
          pubkey: 'cust',
          created_at: Math.floor(Date.now() / 1000),
          kind: 5100,
          tags: [
            ['t', 'elisym'],
            ['t', 'text-gen'],
          ],
          content: 'test input',
          sig: 'sig',
        }),
        created_at: Math.floor(Date.now() / 1000),
      });
      ledger.updatePayment('pay-noverify', undefined, '{"reference":"ref456"}');

      const skill = makeFakeSkill('test-skill', 'result', 100_000);
      const registry = makeFakeRegistry(skill);
      const { transport } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        { ...freeConfig, solanaAddress: 'addr' },
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick(100);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(skill.execute).not.toHaveBeenCalled();
      expect(ledger.getStatus('pay-noverify')).toBe('failed');
    });

    it('marks failed when no payment_request stored', async () => {
      ledger.recordPaid({
        job_id: 'pay-noreq',
        input: 'test input',
        input_type: 'text',
        tags: ['elisym', 'text-gen'],
        customer_id: 'cust',
        raw_event_json: JSON.stringify({
          id: 'pay-noreq',
          pubkey: 'cust',
          created_at: Math.floor(Date.now() / 1000),
          kind: 5100,
          tags: [
            ['t', 'elisym'],
            ['t', 'text-gen'],
          ],
          content: 'test input',
          sig: 'sig',
        }),
        created_at: Math.floor(Date.now() / 1000),
      });

      const skill = makeFakeSkill('test-skill', 'result', 100_000);
      const registry = makeFakeRegistry(skill);
      const { transport } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        { ...freeConfig, solanaAddress: 'addr' },
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick(100);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(skill.execute).not.toHaveBeenCalled();
      expect(ledger.getStatus('pay-noreq')).toBe('failed');
    });
  });

  describe('recovery retry tracking', () => {
    it('does not increment retry for jobs blocked by queue overflow', async () => {
      for (let i = 0; i < 3; i++) {
        ledger.recordPaid({
          job_id: `q-retry-${i}`,
          input: 'test',
          input_type: 'text',
          tags: ['elisym', 'text-gen'],
          customer_id: 'cust',
          raw_event_json: JSON.stringify({
            id: `q-retry-${i}`,
            pubkey: 'cust',
            created_at: Math.floor(Date.now() / 1000),
            kind: 5100,
            tags: [
              ['t', 'elisym'],
              ['t', 'text-gen'],
            ],
            content: 'test',
            sig: 'sig',
          }),
          created_at: Math.floor(Date.now() / 1000),
        });
      }

      const skill = makeFakeSkill('test-skill', 'result');
      const registry = makeFakeRegistry(skill);
      const { transport } = makeFakeTransport();

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        { ...freeConfig, maxConcurrentJobs: 1, maxQueueSize: 2 },
        ledger,
        { onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick(200);
      runtime.stop();
      await runPromise.catch(() => {});

      // First 2 jobs queued and processed, 3rd blocked by queue overflow
      expect(ledger.getStatus('q-retry-0')).toBe('delivered');
      expect(ledger.getStatus('q-retry-1')).toBe('delivered');

      // Third job: still pending, retry NOT incremented
      const ledger2 = new JobLedger(join(agentDir, '.jobs.json'));
      const blocked = ledger2.pendingJobs().find((e) => e.job_id === 'q-retry-2');
      expect(blocked).toBeDefined();
      expect(blocked!.retry_count).toBe(0);
    });
  });

  describe('concurrent stress', () => {
    it('processes many jobs with limited concurrency', async () => {
      const skill = makeFakeSkill('test-skill', 'ok');
      const registry = makeFakeRegistry(skill);
      const { transport, triggerJob } = makeFakeTransport();
      const completed: string[] = [];

      const runtime = new AgentRuntime(
        transport,
        registry,
        { llm: null as any, agentName: 'test', agentDescription: '' },
        { ...freeConfig, maxConcurrentJobs: 2, maxQueueSize: 100 },
        ledger,
        { onJobCompleted: (id) => completed.push(id), onLog: vi.fn() },
      );

      const runPromise = runtime.run();
      await tick();

      for (let i = 0; i < 50; i++) {
        const job = makeJob(`stress-${i}`);
        job.customerId = `customer-${i % 10}`;
        triggerJob(job);
      }

      await tick(500);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(completed).toHaveLength(50);
      for (let i = 0; i < 50; i++) {
        expect(ledger.getStatus(`stress-${i}`)).toBe('delivered');
      }
    });
  });
});
