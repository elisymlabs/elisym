import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ElisymIdentity,
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  buildDelegationAuthProof,
  generateSolanaWallet,
  mintDelegationNonce,
} from '@elisym/sdk';
import type { DelegationStatus } from '@elisym/sdk';
import type { KeyPairSigner } from '@solana/kit';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobLedger, UsedNonceStore } from '../src/ledger.js';
import { AgentRuntime, type RuntimeConfig } from '../src/runtime.js';
import type { SkillRegistry, Skill } from '../src/skill';
import type { NostrTransport, IncomingJob } from '../src/transport/nostr.js';

// Configurable per-test knobs consumed by the SDK mocks below.
let mockDelegationStatus: DelegationStatus | null = null;
let mockPullOutcome: 'landed' | 'assume-landed' | 'dead' | 'unresolved' = 'landed';
let mockReconcileOutcome: 'landed' | 'assume-landed' | 'dead' | 'unresolved' = 'landed';
// A syntactically valid Solana signature (64 chars base58 -> 64 zero bytes):
// the recovery path routes it through kit's `signature()` assertion.
const PULL_SIGNATURE = '1'.repeat(64);
const sendConfirmSpy = vi.fn();
const buildSignedPullSpy = vi.fn();
// The pull AMOUNT is invisible through `buildSignedPullSpy`: it arrives there
// already serialised inside `instructions`. Spy on the builder instead - this is
// the only place the figure is still a number.
const buildDelegatedTransferSpy = vi.fn();
const confirmPullSpy = vi.fn();

// Keep the real crypto (proof build/verify), tag parsing, and ATA derivation;
// stub only the RPC-touching settlement/chain reads so no network is involved.
vi.mock('@elisym/sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    getDelegation: vi.fn(() => Promise.resolve(mockDelegationStatus)),
    buildDelegatedTransfer: (...args: unknown[]) => {
      buildDelegatedTransferSpy(...args);
      return Promise.resolve([]);
    },
    buildSignedPull: (...args: unknown[]) => {
      buildSignedPullSpy(...args);
      return Promise.resolve({
        transaction: {},
        signature: PULL_SIGNATURE,
        lastValidBlockHeight: 424_242n,
      });
    },
    sendConfirmToTerminal: (...args: unknown[]) => {
      sendConfirmSpy(...args);
      return Promise.resolve(mockPullOutcome);
    },
    confirmPullToTerminal: (...args: unknown[]) => {
      confirmPullSpy(...args);
      return Promise.resolve(mockReconcileOutcome);
    },
  };
});

vi.mock('@solana/kit', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    createSolanaRpc: vi.fn().mockReturnValue({ mocked: true }),
  };
});

let agentDir: string;
let ledger: JobLedger;
let nonceStore: UsedNonceStore;
let owner: KeyPairSigner;
let delegate: KeyPairSigner;
let providerWallet: KeyPairSigner;
let customer: ElisymIdentity;

const PRICE_SUBUNITS = 50_000; // 0.05 USDC
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDelegatedSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'delegated-skill',
    description: 'USDC skill accepting delegated payment',
    capabilities: ['text-gen'],
    priceSubunits: PRICE_SUBUNITS,
    asset: USDC_SOLANA_DEVNET,
    delegation: { mechanism: 'spl-approve', suggested_cap_subunits: '50000000' },
    execute: vi.fn().mockResolvedValue({ data: 'delegated result' }),
    ...overrides,
  } as Skill;
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
    waitForPaymentSignature: vi.fn().mockResolvedValue(null),
  } as unknown as NostrTransport;
  return {
    transport,
    triggerJob: (job: IncomingJob) => onJobCb?.(job),
  };
}

async function makeDelegatedJob(
  id: string,
  overrides: {
    nonce?: string;
    expiryUnix?: number;
    proof?: string;
    owner?: string;
    delegatedRejected?: string;
  } = {},
): Promise<IncomingJob> {
  const expiryUnix = overrides.expiryUnix ?? Math.floor(Date.now() / 1000) + 300;
  const nonce = overrides.nonce ?? mintDelegationNonce();
  const ownerAddress = overrides.owner ?? owner.address;
  const proof =
    overrides.proof ??
    (await buildDelegationAuthProof({
      ownerSigner: owner,
      agentDelegate: delegate.address,
      nostrAuthor: customer.publicKey,
      owner: ownerAddress,
      expiryUnix,
      nonce,
    }));
  const delegated = { owner: ownerAddress, expiryUnix, nonce, proof };
  return {
    jobId: id,
    input: 'do the work',
    inputType: 'text',
    tags: ['elisym', 'text-gen'],
    customerId: customer.publicKey,
    encrypted: false,
    rawEvent: {
      id,
      pubkey: customer.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 5100,
      tags: [
        ['i', 'do the work', 'text'],
        ['t', 'elisym'],
        ['t', 'text-gen'],
        ['payment', 'delegated'],
        ['delegation_owner', delegated.owner],
        ['delegation_expiry', String(delegated.expiryUnix)],
        ['delegation_nonce', delegated.nonce],
        ['delegation_proof', delegated.proof],
      ],
      content: 'do the work',
      sig: 'sig',
    },
    delegated: overrides.delegatedRejected === undefined ? delegated : undefined,
    delegatedRejected: overrides.delegatedRejected,
  };
}

function makeRuntime(
  skill: Skill | null,
  transport: NostrTransport,
  configOverrides: Partial<RuntimeConfig> = {},
  irohTransport?: unknown,
): AgentRuntime {
  const config: RuntimeConfig = {
    paymentTimeoutSecs: 30,
    maxConcurrentJobs: 4,
    recoveryMaxRetries: 3,
    recoveryIntervalSecs: 999,
    network: 'devnet',
    solanaAddress: providerWallet.address,
    delegateSigner: delegate,
    ...configOverrides,
  };
  return new AgentRuntime(
    transport,
    makeFakeRegistry(skill),
    { llm: null as any, agentName: 'test', agentDescription: '' },
    config,
    ledger,
    { onLog: vi.fn() },
    undefined,
    irohTransport as any,
    undefined,
    undefined,
    undefined,
    nonceStore,
  );
}

function activeDelegation(overrides: Partial<DelegationStatus> = {}): DelegationStatus {
  return {
    delegate: delegate.address,
    remainingCap: 10_000_000n,
    mint: USDC_SOLANA_DEVNET.mint ?? '',
    owner: owner.address,
    balance: 10_000_000n,
    ...overrides,
  };
}

/** Feedback error messages sent for a job id. */
function feedbackErrors(transport: NostrTransport, jobId: string): string[] {
  return (transport.sendFeedback as any).mock.calls
    .filter((call: any[]) => call[0]?.jobId === jobId && call[1]?.type === 'error')
    .map((call: any[]) => call[1].message as string);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockDelegationStatus = null;
  mockPullOutcome = 'landed';
  mockReconcileOutcome = 'landed';
  agentDir = mkdtempSync(join(tmpdir(), 'elisym-delegated-test-'));
  ledger = new JobLedger(join(agentDir, '.jobs.json'));
  nonceStore = new UsedNonceStore(join(agentDir, '.delegation-nonces.json'));
  owner = (await generateSolanaWallet()).signer;
  delegate = (await generateSolanaWallet()).signer;
  providerWallet = (await generateSolanaWallet()).signer;
  customer = ElisymIdentity.generate();
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

async function runJobs(runtime: AgentRuntime, trigger: () => Promise<void> | void, waitMs = 200) {
  const runPromise = runtime.run();
  await tick();
  await trigger();
  await tick(waitMs);
  runtime.stop();
  await runPromise.catch(() => {});
}

describe('delegated job payment - live path', () => {
  it('happy path: pre-check -> work -> persist -> pull -> deliver with the pull sig', async () => {
    mockDelegationStatus = activeDelegation();
    const skill = makeDelegatedSkill();
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(skill, transport);
    const job = await makeDelegatedJob('happy-1');

    await runJobs(runtime, () => triggerJob(job));

    expect(skill.execute).toHaveBeenCalledOnce();
    expect(buildSignedPullSpy).toHaveBeenCalledOnce();
    // The pull's priority-fee estimate is cluster-keyed: it must be built for
    // the runtime's own network, never a hardcoded one.
    expect(buildSignedPullSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ network: 'devnet' }),
    );
    expect(sendConfirmSpy).toHaveBeenCalledOnce();
    expect((transport as any).deliverResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'happy-1' }),
      'delegated result',
      PRICE_SUBUNITS,
      undefined,
      PULL_SIGNATURE,
    );
    expect(ledger.getStatus('happy-1')).toBe('delivered');
    // Discriminator + pull idempotency state persisted.
    const entry = ledger.allEntries().find((candidate) => candidate.job_id === 'happy-1');
    expect(entry?.delegated).toBe(true);
    expect(entry?.pull_signature).toBe(PULL_SIGNATURE);
    expect(entry?.pull_last_valid_block_height).toBe(424_242);
    expect(entry?.net_amount).toBe(PRICE_SUBUNITS);
    // Nonce burned durably.
    expect(nonceStore.has(`${owner.address}:${job.delegated?.nonce}`)).toBe(true);
    // No payment-required feedback on the delegated path.
    const feedbackTypes = (transport.sendFeedback as any).mock.calls.map(
      (call: any[]) => call[1]?.type,
    );
    expect(feedbackTypes).not.toContain('payment-required');
  });

  it('pull confirm-timeout-but-landed (assume-landed) still delivers exactly once', async () => {
    mockDelegationStatus = activeDelegation();
    mockPullOutcome = 'assume-landed';
    const skill = makeDelegatedSkill();
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('landed-late-1')));

    expect((transport as any).deliverResult).toHaveBeenCalledTimes(1);
    expect(ledger.getStatus('landed-late-1')).toBe('delivered');
  });

  it('positively-absent pull -> error feedback, NO delivery, nonce stays burned', async () => {
    mockDelegationStatus = activeDelegation();
    mockPullOutcome = 'dead';
    const skill = makeDelegatedSkill();
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(skill, transport);
    const job = await makeDelegatedJob('dead-1');

    await runJobs(runtime, () => triggerJob(job));

    expect((transport as any).deliverResult).not.toHaveBeenCalled();
    expect(ledger.getStatus('dead-1')).toBe('failed');
    expect(feedbackErrors(transport, 'dead-1').join(' ')).toMatch(/not charged/i);
    expect(nonceStore.has(`${owner.address}:${job.delegated?.nonce}`)).toBe(true);
  });

  it('empty skill output -> NO pull, failed with error feedback, customer not charged', async () => {
    mockDelegationStatus = activeDelegation();
    // llm/x402 modes can return '' (no source-level empty guard, unlike script
    // modes); the SDK rejects empty content at delivery, so pulling here would
    // charge for an undeliverable result.
    const skill = makeDelegatedSkill({ execute: vi.fn().mockResolvedValue({ data: '' }) });
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(skill, transport);
    const job = await makeDelegatedJob('empty-1');

    await runJobs(runtime, () => triggerJob(job));

    expect(buildSignedPullSpy).not.toHaveBeenCalled();
    expect(sendConfirmSpy).not.toHaveBeenCalled();
    expect((transport as any).deliverResult).not.toHaveBeenCalled();
    expect(ledger.getStatus('empty-1')).toBe('failed');
    expect(feedbackErrors(transport, 'empty-1').join(' ')).toMatch(/empty output.*not charged/i);
  });

  it('unresolved pull leaves the entry paid (with sig) for recovery, no delivery', async () => {
    mockDelegationStatus = activeDelegation();
    mockPullOutcome = 'unresolved';
    const skill = makeDelegatedSkill();
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('unresolved-1')));

    expect((transport as any).deliverResult).not.toHaveBeenCalled();
    expect(ledger.getStatus('unresolved-1')).toBe('paid');
    const entry = ledger.allEntries().find((candidate) => candidate.job_id === 'unresolved-1');
    expect(entry?.pull_signature).toBe(PULL_SIGNATURE);
    expect(entry?.delivered_content).toBe('delegated result');
  });

  it('N concurrent same-nonce events -> exactly one pulls (event-id dedup cannot gate this)', async () => {
    mockDelegationStatus = activeDelegation();
    const skill = makeDelegatedSkill();
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(skill, transport);
    const nonce = mintDelegationNonce();
    const expiryUnix = Math.floor(Date.now() / 1000) + 300;
    const jobA = await makeDelegatedJob('same-nonce-a', { nonce, expiryUnix });
    const jobB = { ...(await makeDelegatedJob('same-nonce-b', { nonce, expiryUnix })) };
    // Same proof rides both events (the attacker replays the observed tags).
    jobB.delegated = jobA.delegated;

    await runJobs(runtime, () => {
      triggerJob(jobA);
      triggerJob(jobB);
    });

    expect(sendConfirmSpy).toHaveBeenCalledTimes(1);
    const statuses = [ledger.getStatus('same-nonce-a'), ledger.getStatus('same-nonce-b')].sort();
    expect(statuses).toEqual(['delivered', 'failed']);
  });

  it('replayed nonce on a later job is rejected at pre-check', async () => {
    mockDelegationStatus = activeDelegation();
    const skill = makeDelegatedSkill();
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(skill, transport);
    const first = await makeDelegatedJob('replay-first');

    await runJobs(runtime, () => triggerJob(first), 150);
    expect(ledger.getStatus('replay-first')).toBe('delivered');

    const replay = await makeDelegatedJob('replay-second', {
      nonce: first.delegated?.nonce,
      expiryUnix: first.delegated?.expiryUnix,
      proof: first.delegated?.proof,
    });
    const runtime2 = makeRuntime(skill, transport);
    await runJobs(runtime2, () => triggerJob(replay), 100);

    expect(ledger.getStatus('replay-second')).toBe('failed');
    expect(feedbackErrors(transport, 'replay-second').join(' ')).toMatch(/already used/i);
    expect(sendConfirmSpy).toHaveBeenCalledTimes(1); // only the first pulled
  });
});

describe('delegated job payment - pre-check rejections', () => {
  async function expectReject(
    job: IncomingJob,
    skill: Skill | null,
    messagePattern: RegExp,
    configOverrides: Partial<RuntimeConfig> = {},
  ) {
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(skill, transport, configOverrides);
    await runJobs(runtime, () => triggerJob(job), 100);
    expect(ledger.getStatus(job.jobId)).toBe('failed');
    expect(feedbackErrors(transport, job.jobId).join(' ')).toMatch(messagePattern);
    expect(sendConfirmSpy).not.toHaveBeenCalled();
    expect((transport as any).deliverResult).not.toHaveBeenCalled();
  }

  it('malformed delegation tags (duplicate-tag parse rejection)', async () => {
    mockDelegationStatus = activeDelegation();
    const job = await makeDelegatedJob('malformed-1', {
      delegatedRejected: 'Duplicate "payment" tag on a delegated payment request.',
    });
    await expectReject(job, makeDelegatedSkill(), /malformed delegation tags/i);
  });

  it('agent without a delegate key', async () => {
    mockDelegationStatus = activeDelegation();
    await expectReject(
      await makeDelegatedJob('no-delegate-1'),
      makeDelegatedSkill(),
      /does not accept delegated payment/i,
      { delegateSigner: undefined },
    );
  });

  it('delegated tag on a skill without a delegation block', async () => {
    mockDelegationStatus = activeDelegation();
    await expectReject(
      await makeDelegatedJob('no-block-1'),
      makeDelegatedSkill({ delegation: undefined }),
      /skill does not accept delegated payment/i,
    );
  });

  it('delegated tag on a free skill', async () => {
    mockDelegationStatus = activeDelegation();
    await expectReject(
      await makeDelegatedJob('free-skill-1'),
      makeDelegatedSkill({ priceSubunits: 0 }),
      /skill does not accept delegated payment/i,
    );
  });

  it('asset mismatch (SOL-priced skill) is rejected by the runtime guard', async () => {
    mockDelegationStatus = activeDelegation();
    await expectReject(
      await makeDelegatedJob('asset-mismatch-1'),
      makeDelegatedSkill({ asset: NATIVE_SOL }),
      /does not accept delegated payment/i,
    );
  });

  it('expired proof', async () => {
    mockDelegationStatus = activeDelegation();
    await expectReject(
      await makeDelegatedJob('expired-1', { expiryUnix: Math.floor(Date.now() / 1000) - 10 }),
      makeDelegatedSkill(),
      /expired/i,
    );
  });

  it('expiry beyond the allowed horizon', async () => {
    mockDelegationStatus = activeDelegation();
    await expectReject(
      await makeDelegatedJob('horizon-1', {
        expiryUnix: Math.floor(Date.now() / 1000) + 3600,
      }),
      makeDelegatedSkill(),
      /too far in the future/i,
    );
  });

  it('invalid proof (tampered nonce)', async () => {
    mockDelegationStatus = activeDelegation();
    const job = await makeDelegatedJob('tampered-1');
    if (job.delegated) {
      job.delegated = { ...job.delegated, nonce: mintDelegationNonce() };
    }
    await expectReject(job, makeDelegatedSkill(), /invalid payment proof/i);
  });

  it('proof signed by a non-owner key (owner != signer)', async () => {
    mockDelegationStatus = activeDelegation();
    const attacker = (await generateSolanaWallet()).signer;
    const expiryUnix = Math.floor(Date.now() / 1000) + 300;
    const nonce = mintDelegationNonce();
    // Attacker signs with THEIR key but claims the victim's owner address.
    const forgedProof = await buildDelegationAuthProof({
      ownerSigner: attacker,
      agentDelegate: delegate.address,
      nostrAuthor: customer.publicKey,
      owner: attacker.address,
      expiryUnix,
      nonce,
    });
    const job = await makeDelegatedJob('forged-1', {
      nonce,
      expiryUnix,
      proof: forgedProof,
    });
    await expectReject(job, makeDelegatedSkill(), /invalid payment proof/i);
  });

  it('delegate mismatch (owner approved a different/rotated key)', async () => {
    const otherDelegate = (await generateSolanaWallet()).signer;
    mockDelegationStatus = activeDelegation({ delegate: otherDelegate.address });
    await expectReject(
      await makeDelegatedJob('rotated-1'),
      makeDelegatedSkill(),
      /no active delegation/i,
    );
  });

  it('no delegation on-chain at all', async () => {
    mockDelegationStatus = null;
    await expectReject(
      await makeDelegatedJob('none-1'),
      makeDelegatedSkill(),
      /no active delegation/i,
    );
  });

  it('insufficient remaining cap', async () => {
    mockDelegationStatus = activeDelegation({ remainingCap: BigInt(PRICE_SUBUNITS - 1) });
    await expectReject(await makeDelegatedJob('cap-low-1'), makeDelegatedSkill(), /allowance/i);
  });

  it('balance below price', async () => {
    mockDelegationStatus = activeDelegation({ balance: BigInt(PRICE_SUBUNITS - 1) });
    await expectReject(await makeDelegatedJob('balance-low-1'), makeDelegatedSkill(), /balance/i);
  });

  it('exact-cap single job passes (own reservation excluded from the check)', async () => {
    mockDelegationStatus = activeDelegation({ remainingCap: BigInt(PRICE_SUBUNITS) });
    const skill = makeDelegatedSkill();
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(skill, transport);
    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('exact-cap-1')));
    expect(ledger.getStatus('exact-cap-1')).toBe('delivered');
  });

  it('concurrent same-owner jobs cannot oversubscribe the cap (reservation)', async () => {
    mockDelegationStatus = activeDelegation({ remainingCap: BigInt(PRICE_SUBUNITS) });
    const slowSkill = makeDelegatedSkill({
      execute: vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve({ data: 'slow result' }), 120)),
      ),
    } as Partial<Skill>);
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(slowSkill, transport);
    const jobA = await makeDelegatedJob('reserve-a');
    const jobB = await makeDelegatedJob('reserve-b');

    await runJobs(
      runtime,
      async () => {
        triggerJob(jobA);
        await tick(50); // A holds its reservation while executing
        triggerJob(jobB);
      },
      350,
    );

    const statuses = [ledger.getStatus('reserve-a'), ledger.getStatus('reserve-b')].sort();
    expect(statuses).toEqual(['delivered', 'failed']);
    expect(sendConfirmSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the reservation when the skill throws after reserve', async () => {
    mockDelegationStatus = activeDelegation({ remainingCap: BigInt(PRICE_SUBUNITS) });
    const throwingSkill = makeDelegatedSkill({
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    } as Partial<Skill>);
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(throwingSkill, transport);
    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('throw-1')), 150);
    expect(sendConfirmSpy).not.toHaveBeenCalled();

    // A follow-up job against the SAME exact cap passes pre-check - a leaked
    // reservation would make `remainingCap - inFlight < price` reject it.
    const okSkill = makeDelegatedSkill();
    const second = makeFakeTransport();
    const runtime2 = makeRuntime(okSkill, second.transport);
    await runJobs(runtime2, async () => second.triggerJob(await makeDelegatedJob('after-throw-1')));
    expect(ledger.getStatus('after-throw-1')).toBe('delivered');
  });
});

describe('delegated job payment - crash recovery', () => {
  function seedDelegatedPaidEntry(
    jobId: string,
    fields: {
      pullSignature?: string;
      lastValidBlockHeight?: number;
      deliveredContent?: string;
      resultAttachments?: string[];
      createdAtSecsAgo?: number;
      nonce?: string;
      expiryUnix?: number;
    } = {},
  ): void {
    const expiryUnix = fields.expiryUnix ?? Math.floor(Date.now() / 1000) + 300;
    const nonce = fields.nonce ?? mintDelegationNonce();
    ledger.recordPaid({
      job_id: jobId,
      input: 'do the work',
      input_type: 'text',
      tags: ['elisym', 'text-gen'],
      customer_id: customer.publicKey,
      raw_event_json: JSON.stringify({
        id: jobId,
        pubkey: customer.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 5100,
        tags: [
          ['i', 'do the work', 'text'],
          ['t', 'elisym'],
          ['t', 'text-gen'],
          ['payment', 'delegated'],
          ['delegation_owner', owner.address],
          ['delegation_expiry', String(expiryUnix)],
          ['delegation_nonce', nonce],
          ['delegation_proof', '1'.repeat(87)],
        ],
        content: 'do the work',
        sig: 'sig',
      }),
      created_at: Math.floor(Date.now() / 1000) - (fields.createdAtSecsAgo ?? 60),
    });
    ledger.markDelegated(jobId);
    if (fields.resultAttachments) {
      ledger.recordAttachment(jobId, { resultAttachments: fields.resultAttachments });
    }
    if (fields.deliveredContent !== undefined) {
      ledger.recordDeliveredContent(jobId, fields.deliveredContent);
    }
    if (fields.pullSignature !== undefined) {
      ledger.recordPullSignature(
        jobId,
        fields.pullSignature,
        fields.lastValidBlockHeight ?? 424_242,
        PRICE_SUBUNITS,
      );
    }
  }

  async function runRecovery(runtime: AgentRuntime, waitMs = 250) {
    const runPromise = runtime.run();
    await tick(waitMs);
    runtime.stop();
    await runPromise.catch(() => {});
  }

  it('crash after landed pull before markExecuted -> delivers persisted result once, no re-pull', async () => {
    seedDelegatedPaidEntry('recover-landed-1', {
      pullSignature: PULL_SIGNATURE,
      deliveredContent: 'persisted result',
    });
    mockReconcileOutcome = 'landed';
    const { transport } = makeFakeTransport();
    const runtime = makeRuntime(makeDelegatedSkill(), transport);

    await runRecovery(runtime);

    expect(confirmPullSpy).toHaveBeenCalledTimes(1);
    expect(buildSignedPullSpy).not.toHaveBeenCalled(); // never re-sign
    expect(sendConfirmSpy).not.toHaveBeenCalled(); // never re-broadcast
    expect((transport as any).deliverResult).toHaveBeenCalledTimes(1);
    expect((transport as any).deliverResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'recover-landed-1' }),
      'persisted result',
      PRICE_SUBUNITS,
      undefined,
      PULL_SIGNATURE,
    );
    expect(ledger.getStatus('recover-landed-1')).toBe('delivered');
  });

  it('crash after persist-sig before send -> dead at blockhash expiry -> failed, no charge, no delivery', async () => {
    seedDelegatedPaidEntry('recover-dead-1', {
      pullSignature: PULL_SIGNATURE,
      deliveredContent: 'phantom result',
    });
    mockReconcileOutcome = 'dead';
    const { transport } = makeFakeTransport();
    const runtime = makeRuntime(makeDelegatedSkill(), transport);

    await runRecovery(runtime);

    expect((transport as any).deliverResult).not.toHaveBeenCalled();
    expect(ledger.getStatus('recover-dead-1')).toBe('failed');
  });

  it('unresolved reconcile leaves the entry paid for the next tick', async () => {
    seedDelegatedPaidEntry('recover-unresolved-1', {
      pullSignature: PULL_SIGNATURE,
      deliveredContent: 'still pending',
    });
    mockReconcileOutcome = 'unresolved';
    const { transport } = makeFakeTransport();
    const runtime = makeRuntime(makeDelegatedSkill(), transport);

    await runRecovery(runtime);

    expect((transport as any).deliverResult).not.toHaveBeenCalled();
    expect(ledger.getStatus('recover-unresolved-1')).toBe('paid');
  });

  it('>24h-old delegated entry with a landed pull reconciles + delivers, NOT force-failed', async () => {
    seedDelegatedPaidEntry('recover-old-1', {
      pullSignature: PULL_SIGNATURE,
      deliveredContent: 'old but charged',
      createdAtSecsAgo: 25 * 60 * 60,
    });
    mockReconcileOutcome = 'landed';
    const { transport } = makeFakeTransport();
    const runtime = makeRuntime(makeDelegatedSkill(), transport);

    await runRecovery(runtime);

    expect(ledger.getStatus('recover-old-1')).toBe('delivered');
    expect((transport as any).deliverResult).toHaveBeenCalledTimes(1);
  });

  it('delegated paid entry with NO pull signature is failed terminally (no charge)', async () => {
    seedDelegatedPaidEntry('recover-nopull-1', { deliveredContent: 'unpulled' });
    const { transport } = makeFakeTransport();
    const skill = makeDelegatedSkill();
    const runtime = makeRuntime(skill, transport);

    await runRecovery(runtime);

    expect(ledger.getStatus('recover-nopull-1')).toBe('failed');
    expect(skill.execute).not.toHaveBeenCalled(); // no re-execution for delegated entries
    expect((transport as any).deliverResult).not.toHaveBeenCalled();
    expect(feedbackErrors(transport, 'recover-nopull-1').join(' ')).toMatch(/not charged/i);
  });

  it('spilled/file result recovery re-shares attachments (non-empty delivery)', async () => {
    const storedAttachment = JSON.stringify({
      name: 'result.txt',
      size: 70_000,
      mime: 'text/plain',
      transports: [{ kind: 'iroh', ticket: 'stale-ticket' }],
    });
    seedDelegatedPaidEntry('recover-spill-1', {
      pullSignature: PULL_SIGNATURE,
      deliveredContent: '',
      resultAttachments: [storedAttachment],
    });
    mockReconcileOutcome = 'landed';
    const iroh = {
      reShare: vi.fn().mockResolvedValue('fresh-ticket'),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const { transport } = makeFakeTransport();
    const runtime = makeRuntime(makeDelegatedSkill(), transport, {}, iroh);

    await runRecovery(runtime);

    expect(iroh.reShare).toHaveBeenCalledWith('stale-ticket');
    expect((transport as any).deliverResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'recover-spill-1' }),
      '',
      PRICE_SUBUNITS,
      [
        expect.objectContaining({
          transports: [{ kind: 'iroh', ticket: 'fresh-ticket' }],
        }),
      ],
      PULL_SIGNATURE,
    );
    expect(ledger.getStatus('recover-spill-1')).toBe('delivered');
  });

  it('blob-gone on a charged entry fails TERMINALLY (never left paid to loop forever)', async () => {
    const storedAttachment = JSON.stringify({
      name: 'result.txt',
      size: 70_000,
      mime: 'text/plain',
      transports: [{ kind: 'iroh', ticket: 'stale-ticket' }],
    });
    seedDelegatedPaidEntry('recover-blobgone-1', {
      pullSignature: PULL_SIGNATURE,
      deliveredContent: '',
      resultAttachments: [storedAttachment],
    });
    mockReconcileOutcome = 'landed';
    const iroh = {
      reShare: vi.fn().mockRejectedValue(new Error('blob gone')),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const { transport } = makeFakeTransport();
    const runtime = makeRuntime(makeDelegatedSkill(), transport, {}, iroh);

    await runRecovery(runtime);

    expect(ledger.getStatus('recover-blobgone-1')).toBe('failed');
    expect((transport as any).deliverResult).not.toHaveBeenCalled();
    // The one CHARGED terminal must not be silent: the customer gets an error
    // feedback naming the landed pull tx (unlike the no-charge terminals,
    // which truthfully say "you were not charged").
    const messages = feedbackErrors(transport, 'recover-blobgone-1');
    expect(messages.join(' ')).toContain(PULL_SIGNATURE);
    expect(messages.join(' ')).not.toMatch(/not charged/i);
  });

  it('reconciles burned nonces from raw events on restart (replay rejected pre-check)', async () => {
    const nonce = mintDelegationNonce();
    const expiryUnix = Math.floor(Date.now() / 1000) + 300;
    seedDelegatedPaidEntry('recover-nonce-1', {
      pullSignature: PULL_SIGNATURE,
      deliveredContent: 'done',
      nonce,
      expiryUnix,
    });
    mockReconcileOutcome = 'landed';
    // Fresh store simulates a lost nonce-set flush.
    const freshStorePath = join(agentDir, '.delegation-nonces-fresh.json');
    nonceStore = new UsedNonceStore(freshStorePath);
    expect(nonceStore.has(`${owner.address}:${nonce}`)).toBe(false);

    mockDelegationStatus = activeDelegation();
    const { transport, triggerJob } = makeFakeTransport();
    const runtime = makeRuntime(makeDelegatedSkill(), transport);
    const replay = await makeDelegatedJob('replay-after-restart', { nonce, expiryUnix });

    await runJobs(runtime, () => triggerJob(replay), 200);

    expect(nonceStore.has(`${owner.address}:${nonce}`)).toBe(true);
    expect(ledger.getStatus('replay-after-restart')).toBe('failed');
    expect(feedbackErrors(transport, 'replay-after-restart').join(' ')).toMatch(/already used/i);
  });
});

/**
 * Metered pricing: the pull moves what the skill reported, clamped into the
 * range the CARD published (`[metered.min, price]`).
 *
 * Every assertion here reads `buildDelegatedTransferSpy`, not
 * `buildSignedPullSpy`. By the time the amount reaches `buildSignedPull` it is
 * serialised inside `instructions`, so asserting on that spy would pass while
 * proving nothing - on a payment path that is worse than no test at all.
 */
describe('AgentRuntime > metered delegated pricing', () => {
  const MIN_SUBUNITS = 1_000n; // 0.001 USDC floor
  const CEILING = BigInt(PRICE_SUBUNITS); // 0.05 USDC ceiling (the card's `price`)

  function makeMeteredSkill(reported: bigint | undefined): Skill {
    return makeDelegatedSkill({
      meteredMinSubunits: MIN_SUBUNITS,
      execute: vi.fn().mockResolvedValue({
        data: 'metered result',
        ...(reported !== undefined ? { chargeSubunits: reported } : {}),
      }),
    } as Partial<Skill>);
  }

  function pulledAmount(): bigint {
    expect(buildDelegatedTransferSpy).toHaveBeenCalledOnce();
    return (buildDelegatedTransferSpy.mock.calls[0]![0] as { amount: bigint }).amount;
  }

  beforeEach(() => {
    mockDelegationStatus = {
      delegate: undefined as unknown as string,
      remainingCap: 50_000_000n,
      balance: 50_000_000n,
    } as any;
  });

  it('charges exactly what the skill reported when it sits inside the range', async () => {
    const skill = makeMeteredSkill(6_100n);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-in-range')));

    expect(pulledAmount()).toBe(6_100n);
    const entry = ledger.allEntries().find((c) => c.job_id === 'metered-in-range');
    expect(entry?.net_amount).toBe(6_100);
  });

  it('raises a below-floor report to the published minimum', async () => {
    const skill = makeMeteredSkill(1n);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-below')));

    expect(pulledAmount()).toBe(MIN_SUBUNITS);
  });

  it('never bills above the ceiling the buyer approved, however large the report', async () => {
    const skill = makeMeteredSkill(CEILING * 1_000n);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-above')));

    expect(pulledAmount()).toBe(CEILING);
  });

  it('falls back to the ceiling when a metered skill reports nothing', async () => {
    const skill = makeMeteredSkill(undefined);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-silent')));

    expect(pulledAmount()).toBe(CEILING);
  });

  it('ignores a reported charge from a skill that never declared metering', async () => {
    // The card advertised a flat price, so the buyer was quoted a flat price -
    // a stray charge file must not quietly change what is billed either way.
    const skill = makeDelegatedSkill({
      execute: vi.fn().mockResolvedValue({ data: 'flat result', chargeSubunits: 7n }),
    } as Partial<Skill>);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-undeclared')));

    expect(pulledAmount()).toBe(CEILING);
  });

  it('reports the charged amount to the customer, not the reserved ceiling', async () => {
    const skill = makeMeteredSkill(6_100n);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-deliver')));

    expect((transport as any).deliverResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'metered-deliver' }),
      'metered result',
      6_100,
      undefined,
      PULL_SIGNATURE,
    );
  });

  it('never bills above the ceiling even if the floor invariant is violated', async () => {
    // Defence in depth for the ONE property that must always hold: never more
    // than the price the buyer approved. The loader and the publish mirror both
    // enforce `min <= price`, so this state is unreachable through normal
    // configuration - it is constructed here directly to prove the clamp does
    // not rely on that invariant. A first-wins if/else-if clamp would bill the
    // floor (above the ceiling) and fail this.
    const skill = makeDelegatedSkill({
      meteredMinSubunits: CEILING * 10n,
      execute: vi.fn().mockResolvedValue({ data: 'metered result', chargeSubunits: 1n }),
    } as Partial<Skill>);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-inverted')));

    expect(pulledAmount()).toBe(CEILING);
  });

  it('refuses a non-bigint report rather than letting it reach the transfer', async () => {
    // `SkillOutput.chargeSubunits` is a PUBLIC field typed bigint, but a
    // programmatic SDK skill can put anything there. A number would coerce
    // silently through the `<`/`>` comparisons and reach buildDelegatedTransfer
    // as a number, so it is refused outright and the ceiling is billed.
    const skill = makeDelegatedSkill({
      meteredMinSubunits: MIN_SUBUNITS,
      execute: vi.fn().mockResolvedValue({
        data: 'metered result',
        chargeSubunits: 6100 as unknown as bigint,
      }),
    } as Partial<Skill>);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-nonbigint')));

    expect(pulledAmount()).toBe(CEILING);
  });

  // A numeric floor is NOT caught by the `floor <= 0n` half: mixed relational
  // comparison is legal, so `1000 <= 0n` is false and the value would flow on to
  // become `charged` and reach buildDelegatedTransfer as a Number. That is why
  // the type half of the guard exists, and why this asserts the pulled type too.
  it('bills the ceiling when the floor is a number rather than a bigint', async () => {
    const skill = makeDelegatedSkill({
      meteredMinSubunits: 1000 as unknown as bigint,
      execute: vi.fn().mockResolvedValue({ data: 'metered result', chargeSubunits: 1n }),
    } as Partial<Skill>);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-numfloor')));

    expect(pulledAmount()).toBe(CEILING);
    expect(typeof pulledAmount()).toBe('bigint');
  });

  it('refuses a non-positive floor rather than killing the job after the work ran', async () => {
    // A zero floor would let a zero report clamp to zero, and the transfer
    // builder rejects a non-positive amount - AFTER the result was produced and
    // persisted. `meteredMinSubunits` is a plain public field, so the loader's
    // guarantee is not enough on its own.
    const skill = makeDelegatedSkill({
      meteredMinSubunits: 0n,
      execute: vi.fn().mockResolvedValue({ data: 'metered result', chargeSubunits: 0n }),
    } as Partial<Skill>);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-zero-floor')));

    // Only this assertion carries the guard: `buildDelegatedTransfer` is mocked
    // here and never rejects a non-positive amount the way the real one does,
    // so a status check would pass either way and prove nothing.
    expect(pulledAmount()).toBe(CEILING);
  });

  it('a job with no delegation tags never reaches the metered pull at all', async () => {
    // The feature's money invariant on the NON-delegated rail: metering lives
    // entirely inside the delegated branch, so an ordinary paid job on a metered
    // skill cannot have its charge influenced by what the skill reports. It
    // settles up front, for the ceiling, through collectPayment.
    //
    // This asserts the PROPERTY, which two layers protect: the `claimsDelegated`
    // branch and, behind it, the pre-check's own "malformed delegation tags"
    // gate. Verified by falsification - forcing `claimsDelegated` true alone
    // still yields no pull, because the pre-check then rejects.
    const skill = makeMeteredSkill(6_100n);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    const delegated = await makeDelegatedJob('metered-ordinary');
    const plain = { ...delegated, delegated: undefined, delegatedRejected: undefined };

    await runJobs(runtime, () => triggerJob(plain as never));

    expect(buildDelegatedTransferSpy).not.toHaveBeenCalled();
    expect(buildSignedPullSpy).not.toHaveBeenCalled();
  });

  it('recovery delivers the METERED amount, not the ceiling', async () => {
    // The chain under test: the pull persists `net_amount` = charged, the crash
    // window leaves the entry `paid`, and `reconcileDelegatedEntry` later
    // delivers from the ledger. If any link reverted to the skill price, a
    // metered job would report the ceiling to the customer after a crash while
    // the chain moved something smaller.
    mockPullOutcome = 'unresolved';
    const skill = makeMeteredSkill(6_100n);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-recover')));

    // Phase A persisted the charged figure; nothing was delivered yet.
    expect((transport as any).deliverResult).not.toHaveBeenCalled();
    const paidEntry = ledger.allEntries().find((c) => c.job_id === 'metered-recover');
    expect(paidEntry?.net_amount).toBe(6_100);

    mockReconcileOutcome = 'landed';
    const { transport: transport2 } = makeFakeTransport();
    const runtime2 = makeRuntime(skill, transport2);
    const runPromise = runtime2.run();
    await new Promise((resolve) => setTimeout(resolve, 250));
    runtime2.stop();
    await runPromise.catch(() => {});

    expect((transport2 as any).deliverResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'metered-recover' }),
      'metered result',
      6_100,
      undefined,
      PULL_SIGNATURE,
    );
  });

  it('releases the reserved CEILING, not the charged amount', async () => {
    // Releasing the smaller charged figure would leak the difference in
    // `delegationInFlight` for the process lifetime - the map has no GC.
    const skill = makeMeteredSkill(6_100n);
    const { transport, triggerJob } = makeFakeTransport();
    mockDelegationStatus = { ...(mockDelegationStatus as any), delegate: delegate.address } as any;
    const runtime = makeRuntime(skill, transport);

    await runJobs(runtime, async () => triggerJob(await makeDelegatedJob('metered-release')));

    expect((runtime as any).delegationInFlight.size).toBe(0);
  });
});
