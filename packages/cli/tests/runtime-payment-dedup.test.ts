/**
 * Provider-side settlement de-duplication for the FLAT paid path.
 *
 * The SDK verifier is stateless by contract (see `PaymentStrategy.verifyPayment`),
 * so the mock below returns the SAME `txSignature` for every request - exactly
 * what the real SDK does when one transaction carries several job references.
 * Two invariants are under test:
 *   1. only ONE job may consume a given settlement signature;
 *   2. a refused settlement is never evidence that a customer failed to pay, so
 *      it must not end the job, pin its concurrency slot, or make it terminal.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, NATIVE_SOL } from '@elisym/sdk';
import { LlmHealthError } from '@elisym/sdk/llm-health';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobLedger } from '../src/ledger.js';
import {
  ADDRESS_HISTORY_PROBE_ADDRESS,
  CLUSTER_GENESIS_HASHES,
  OWN_SETTLEMENT_VERIFY_RETRIES,
  RECOVERY_DEFER_BACKOFF_TICKS,
  RecoveryDeferrals,
  REFERENCE_SCAN_DEADLINE_MS,
  REFERENCE_SCAN_LIST_ATTEMPTS,
  REFERENCE_SCAN_LIST_RETRY_DELAY_MS,
  REFERENCE_SCAN_VERIFY_RETRIES,
  REFERENCE_SCAN_WINDOW,
  TERMINAL_CONFIRMATION_MIN_RUNG,
  needsPaymentScan,
  recoveryDeferDelayMs,
  recoveryScanBudgetPerTick,
} from '../src/payment-recovery.js';
import type { RecoveryDeferral } from '../src/payment-recovery.js';
import { AgentRuntime, type RuntimeConfig } from '../src/runtime.js';
import type { Skill, SkillRegistry } from '../src/skill';
import type { NostrTransport, IncomingJob } from '../src/transport/nostr.js';

/** The single on-chain transfer reported for every job. */
const SHARED_SIGNATURE = 'sharedDoublePaySignature';
/** A distinct, genuine transfer that settles one job and nothing else. */
const GENUINE_SIGNATURE = 'genuineOwnTransferSignature';
/** The settlement a crashed job had already claimed for itself before dying. */
const OWN_CLAIMED_SIGNATURE = 'alreadyClaimedByThisJobSignature';
/** The SDK's one conclusive "nothing on-chain targets this request" result. */
const DEFINITIVE_NO_PAYMENT = 'No matching transaction found for reference key';
/**
 * What a customer whose payment never landed is actually told. It must read as
 * "no payment arrived" and must keep matching `CUSTOMER_SAFE_MESSAGE_PREFIXES`
 * in `runtime.ts`; a message that stops matching collapses to "Internal
 * processing error" and tells every non-paying customer the agent broke.
 */
const PAYMENT_TIMEOUT_CUSTOMER_MESSAGE =
  'Payment timeout: no payment received before the deadline.';

/**
 * Payment window for every runtime here. Deliberately far longer than any
 * assertion budget below: a regression that waits the window out instead of
 * resolving as soon as both verify paths have lost trips `waitFor`, and the
 * suite still runs fast because nothing is supposed to reach the deadline.
 */
const PAYMENT_WINDOW_MS = 6_000;
/**
 * Budget for "this should already have happened", polled not slept. Generous on
 * purpose: these are POLLING ceilings, not sleeps, so a passing run returns as
 * soon as the condition holds and only a genuine hang spends the whole budget.
 * A tight ceiling buys nothing and turns a contended CI box into a flake.
 */
const PROMPT_MS = 10_000;
/** Budget for something that has to survive a 1s recovery tick first. */
const NEXT_TICK_MS = 20_000;
/**
 * Budget for something that has to survive a DEFERRAL BACKOFF first. The
 * backoff ladder is counted in recovery ticks (`RECOVERY_DEFER_BACKOFF_TICKS`),
 * so at the 1s interval these tests use the first deferral costs 1s and the
 * second 2s - this budget covers a couple of rungs plus scheduling slack.
 */
const BACKOFF_MS = 30_000;

/** The transaction a reference scan finds when a test does not say otherwise. */
const REF_SCAN_CANDIDATE = 'refScanCandidateSignature';

/**
 * Addresses the fixtures use. Real base58/32-byte values, because the `address()`
 * below is the REAL parser: a placeholder like `'ref'` is rejected by
 * `@solana/kit` exactly as it would be in production, so a fixture that uses one
 * is not exercising the shipped code at all.
 */
const PAYMENT_REFERENCE = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const PROVIDER_ADDRESS = 'So11111111111111111111111111111111111111112';
const TREASURY_ADDRESS = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
/** Matches the `getProtocolConfig` mock below; 3% of `PRICE_SUBUNITS`. */
const FEE_BPS = 300;

/** One entry of the fake `getSignaturesForAddress` listing. */
interface FakeSignatureEntry {
  signature: string;
  /** A failed transaction moved nothing; the scan must not see it at all. */
  failed?: boolean;
}

/** One `verifyPayment` call, as the runtime made it. */
interface VerifyCall {
  txSignature?: string;
  retries?: number;
}

// Reset in beforeEach.
/** What verifying a SPECIFIC signature yields - the SDK's `_verifyBySignature`. */
let sigPathVerify: (txSignature: string) => unknown;
/** What verifying a signature the reference scan produced yields. */
let refPathVerify: (candidateSignature?: string) => unknown;
/** What `getSignaturesForAddress` lists for the reference, newest first. */
let refScanEntries: FakeSignatureEntry[];
/** Set to make the listing itself fail (an RPC outage mid-scan). */
let refScanFailure: Error | null;
/** How many further listing attempts fail before the listing starts working. */
let refScanTransientFailures: number;
/** Wall-clock the listing itself burns, so a scan deadline can be load-bearing. */
let refScanListDelayMs: number;
/** `getSignaturesForAddress` calls, so a test can wait for one instead of sleeping. */
let refScanCalls = 0;
/** When each listing attempt ran, so a test can pin the PAUSE between retries. */
let refScanTimestamps: number[];
/** Runs at the start of every listing attempt, so a test can move the clock. */
let refScanOnAttempt: (() => void) | null;
/** The `commitment` each listing asked for - it must match what the verifier reads. */
let refScanCommitments: (string | undefined)[];
/** The `limit` each listing asked for - one scan is exactly one SDK-sized window. */
let refScanLimits: (number | undefined)[];
/** Every `verifyPayment` call, so a test can pin the retry budget it was given. */
let verifyCalls: VerifyCall[];
/**
 * What the endpoint answers `getGenesisHash` with. Defaults to devnet's real
 * hash, which is the cluster every runtime here is configured for - a terminal
 * no-payment verdict is refused outright on an endpoint that cannot prove it is
 * the right chain.
 */
let genesisHash: string;
/** Set to make `getGenesisHash` itself fail (an endpoint that will not answer). */
let genesisFailure: Error | null;
/**
 * Set to make the client fail WITHOUT EVER AWAITING - a transport that rejects
 * an unusable URL on the spot. Distinct from `genesisFailure`, which fails one
 * turn of the event loop later: this one settles the whole endpoint check
 * synchronously, which is the case the probe's single-flight slot must survive.
 */
let genesisThrowsSynchronously: boolean;
/** How many times the endpoint was asked which chain it is - the check is cached. */
let genesisCalls: number;
/** Set to make the address-history PROBE fail while the reference listing works. */
let historyProbeFailure: Error | null;
/** Addresses the fake RPC was asked to list, so a test can see the probe happen. */
let listedAddresses: string[];

function isRefScanCandidate(txSignature: string): boolean {
  return refScanEntries.some((entry) => entry.signature === txSignature);
}

/**
 * A payment request in the shape the real SDK mints one: fee fields and network
 * included, so what the ledger persists is something the SDK's own
 * `validatePaymentRequest` would accept.
 *
 * `createdAt`/`expirySecs` default to a request whose own window has ALREADY
 * closed, because recovery refuses a terminal no-payment verdict before
 * `created_at + expiry_secs` and most tests here are about what happens after
 * it. The gate itself has its own tests.
 */
function paymentRequestFixture(
  options: { reference?: string; createdAt?: number; expirySecs?: number } = {},
): Record<string, unknown> {
  const feeAmount = Math.floor((PRICE_SUBUNITS * FEE_BPS) / 10_000);
  return {
    recipient: PROVIDER_ADDRESS,
    amount: PRICE_SUBUNITS,
    reference: options.reference ?? PAYMENT_REFERENCE,
    fee_address: TREASURY_ADDRESS,
    fee_amount: feeAmount,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000) - 700,
    expiry_secs: options.expirySecs ?? 600,
    network: 'devnet',
  };
}

/**
 * Faithful-enough `getSignaturesForAddress`: newest first, honours `limit`, and
 * reports `err` in the shape the runtime actually reads. It deliberately does
 * NOT implement a `before` cursor - the scan is one window by design, and
 * `refScanCalls` pins that.
 */
function fakeGetSignaturesForAddress(
  queried: string,
  config?: { limit?: number; commitment?: string },
): { send: () => Promise<unknown[]> } {
  const limit = config?.limit ?? 1000;
  const commitment = config?.commitment;
  if (queried === ADDRESS_HISTORY_PROBE_ADDRESS) {
    // The endpoint-soundness probe, not a reference scan: it must not be
    // counted, delayed or failed by the knobs that drive the scan itself.
    return {
      send: async () => {
        listedAddresses.push(queried);
        if (historyProbeFailure) {
          throw historyProbeFailure;
        }
        return [];
      },
    };
  }
  return {
    send: async () => {
      listedAddresses.push(queried);
      refScanCalls += 1;
      refScanTimestamps.push(Date.now());
      refScanOnAttempt?.();
      refScanCommitments.push(commitment);
      refScanLimits.push(config?.limit);
      if (refScanListDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, refScanListDelayMs));
      }
      if (refScanTransientFailures > 0) {
        refScanTransientFailures -= 1;
        throw refScanFailure ?? new Error('429 Too Many Requests');
      }
      if (refScanFailure) {
        throw refScanFailure;
      }
      return refScanEntries.slice(0, limit).map((entry) => ({
        signature: entry.signature,
        err: entry.failed === true ? { InstructionError: [0, 'Custom'] } : null,
        blockTime: BigInt(Math.floor(Date.now() / 1000)),
      }));
    },
  };
}

vi.mock('@elisym/sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    SolanaPaymentStrategy: vi.fn().mockImplementation(() => ({
      // The SHAPE the real `createPaymentRequest` returns, fee fields included:
      // a request without `fee_address`/`fee_amount`/`network` is one the SDK's
      // own `validatePaymentRequest` would reject, so a fixture missing them
      // persists a `payment_request` no real customer or verifier would accept.
      createPaymentRequest: vi.fn().mockImplementation(() => paymentRequestFixture()),
      verifyPayment: vi
        .fn()
        .mockImplementation(
          (
            _rpc: unknown,
            _req: unknown,
            _cfg: unknown,
            options?: { txSignature?: string; retries?: number },
          ) => {
            const txSignature = options?.txSignature;
            verifyCalls.push({ txSignature, retries: options?.retries });
            // No signature: the SDK's own reference path, which only the LIVE
            // verify race still uses. A signature the scan produced routes to
            // `refPathVerify`; anything else is the customer-asserted one.
            if (txSignature === undefined) {
              return Promise.resolve(refPathVerify());
            }
            return Promise.resolve(
              isRefScanCandidate(txSignature)
                ? refPathVerify(txSignature)
                : sigPathVerify(txSignature),
            );
          },
        ),
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

vi.mock('@solana/kit', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    createSolanaRpc: vi.fn().mockReturnValue({
      getTransaction: vi.fn(),
      getSignaturesForAddress: vi.fn(fakeGetSignaturesForAddress),
      getGenesisHash: vi.fn(() => {
        if (genesisThrowsSynchronously) {
          throw new Error('fetch failed: invalid URL');
        }
        return {
          send: async () => {
            genesisCalls += 1;
            if (genesisFailure) {
              throw genesisFailure;
            }
            return genesisHash;
          },
        };
      }),
    }),
    // Everything else - `address`, `signature`, `isAddress` - comes through
    // REAL, deliberately. A permissive stand-in accepts values `@solana/kit`
    // rejects, so every fixture below would be exercising a code path the
    // shipped agent never takes, and the corrupt-state branch would look tested
    // when it is not.
  };
});

let agentDir: string;
let ledgerPath: string;
let ledger: JobLedger;
/** Operator log lines emitted by the runtime under test. */
let logs: string[];

const PRICE_SUBUNITS = 100_000;
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `predicate` until it holds, or fail with `label`. Polling (rather than
 * asserting after a fixed sleep) is what keeps these tests both fast and robust
 * on a loaded machine: they return the moment the condition is true and only
 * spend the whole budget when something is genuinely broken.
 */
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = PROMPT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await tick(10);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** The runtime's configured recovery interval, in ms. */
function runtimeIntervalMs(runtime: AgentRuntime): number {
  return (
    (runtime as unknown as { config: { recoveryIntervalSecs: number } }).config
      .recoveryIntervalSecs * 1000
  );
}

/** Wait until every job the recovery loop queued has finished. */
async function drainRecovery(runtime: AgentRuntime): Promise<void> {
  await waitFor(
    () => (runtime as unknown as { pending: number }).pending === 0,
    'the recovery tick drained',
    NEXT_TICK_MS,
  );
}

/**
 * TEST SEAM: drop the WAIT from every deferral while keeping the EVIDENCE (the
 * attempt count and the empty-scan sighting).
 *
 * Deliberately a reach into the map from the test side rather than a method on
 * `RecoveryDeferrals`: nothing in the agent ever wants to cancel a backoff, and
 * a public mutator that exists only for tests is a production surface with no
 * production meaning.
 */
function releaseDeferralBackoff(deferrals: RecoveryDeferrals): void {
  const internals = deferrals as unknown as {
    deferrals: Map<string, RecoveryDeferral>;
  };
  for (const [jobId, deferral] of internals.deferrals) {
    internals.deferrals.set(jobId, { ...deferral, nextAttemptAt: 0 });
  }
}

/**
 * Run ONE recovery tick and wait for it to drain, ignoring any backoff window.
 * Lets a test pin an exact SEQUENCE of scan outcomes instead of racing the
 * interval - the backoff itself is covered by its own tests.
 */
async function runRecoveryTick(runtime: AgentRuntime): Promise<void> {
  releaseDeferralBackoff(runtime.recoveryDeferrals);
  const internals = runtime as unknown as { recoverPendingJobs: () => Promise<void> };
  await internals.recoverPendingJobs();
  await drainRecovery(runtime);
}

function makeJob(id: string): IncomingJob {
  return {
    jobId: id,
    input: 'test input',
    inputType: 'text',
    tags: ['elisym', 'text-gen'],
    customerId: 'double-spender',
    encrypted: false,
    rawEvent: {
      id,
      pubkey: 'double-spender',
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

function makePaidSkill(): Skill {
  return {
    name: 'paid-skill',
    description: 'Paid skill',
    capabilities: ['text-gen'],
    priceSubunits: PRICE_SUBUNITS,
    asset: NATIVE_SOL,
    execute: vi.fn().mockResolvedValue({ data: 'work done' }),
  };
}

function makeFakeRegistry(skill: Skill | null): SkillRegistry {
  return {
    register: vi.fn(),
    route: vi.fn().mockReturnValue(skill),
    allCapabilities: vi.fn().mockReturnValue(['text-gen']),
  } as unknown as SkillRegistry;
}

/** What the customer of a given job claims in their `payment-completed`. */
interface SignatureReport {
  /** `null` leaves the reference scan as the only way in. */
  signature: string | null;
  /** Delay before the feedback arrives, so a test can order the two paths. */
  afterMs?: number;
}

function makeFakeTransport(report: (jobId: string) => SignatureReport): {
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
    waitForPaymentSignature: vi.fn().mockImplementation((jobId: string) => {
      const { signature, afterMs } = report(jobId);
      return afterMs
        ? new Promise((resolve) => setTimeout(() => resolve(signature), afterMs))
        : Promise.resolve(signature);
    }),
  } as unknown as NostrTransport;
  return {
    transport,
    triggerJob: (job: IncomingJob) => onJobCb?.(job),
  };
}

/** Every job reports the same signature (or none). */
const always = (signature: string | null, afterMs?: number) => () => ({ signature, afterMs });

function makeRuntime(
  skill: Skill | null,
  transport: NostrTransport,
  jobLedger: JobLedger = ledger,
  overrides: Partial<RuntimeConfig> = {},
  healthMonitor?: { assertReady: (provider: string, model: string) => Promise<void> },
): AgentRuntime {
  const config: RuntimeConfig = {
    paymentTimeoutSecs: PAYMENT_WINDOW_MS / 1000,
    maxConcurrentJobs: 4,
    recoveryMaxRetries: 3,
    recoveryIntervalSecs: 999,
    network: 'devnet',
    solanaAddress: PROVIDER_ADDRESS,
    ...overrides,
  };
  return new AgentRuntime(
    transport,
    makeFakeRegistry(skill),
    { llm: null as any, agentName: 'test', agentDescription: '' },
    config,
    jobLedger,
    { onLog: (message: string) => logs.push(message) },
    healthMonitor as never,
  );
}

/** Whether any operator log line matched. */
function logged(pattern: RegExp): boolean {
  return logs.some((line) => pattern.test(line));
}

/** Job ids `deliverResult` was called for. */
function deliveredJobIds(transport: NostrTransport): string[] {
  return (transport.deliverResult as any).mock.calls.map((call: any[]) => call[0]?.jobId as string);
}

/** Error messages the customer of `jobId` received. */
function errorMessages(transport: NostrTransport, jobId: string): string[] {
  return (transport.sendFeedback as any).mock.calls
    .filter((call: any[]) => call[0]?.jobId === jobId && call[1]?.type === 'error')
    .map((call: any[]) => call[1].message as string);
}

function retryCount(targetLedger: JobLedger, jobId: string): number | undefined {
  return targetLedger.allEntries().find((entry) => entry.job_id === jobId)?.retry_count;
}

/** A delivered job that already consumed `signature` - the stranger's transfer. */
function seedConsumedSettlement(targetLedger: JobLedger, jobId: string, signature: string): void {
  targetLedger.recordPaid({
    job_id: jobId,
    input: 'test input',
    input_type: 'text',
    tags: ['elisym', 'text-gen'],
    customer_id: 'stranger',
    created_at: Math.floor(Date.now() / 1000),
  });
  targetLedger.claimPaymentSignature(signature, jobId);
  targetLedger.markExecuted(jobId, 'done');
  targetLedger.markDelivered(jobId);
}

/**
 * A `paid` entry that crashed before `net_amount` was recorded.
 *
 * Its payment request is EXPIRED by default (issued 700s ago with a 600s
 * window), because recovery refuses to issue a terminal no-payment verdict
 * before `created_at + expiry_secs` and most tests here are about what the scan
 * concludes once the customer's own window has closed. `stillOpen` keeps the
 * window open instead, for the tests that are about the gate itself.
 */
function recordCrashedPaidJob(
  targetLedger: JobLedger,
  jobId: string,
  options: {
    stillOpen?: boolean;
    createdAt?: number;
    expirySecs?: number;
    rawEvent?: Record<string, unknown>;
  } = {},
): void {
  const now = Math.floor(Date.now() / 1000);
  targetLedger.recordPaid({
    job_id: jobId,
    input: 'test input',
    input_type: 'text',
    tags: ['elisym', 'text-gen'],
    customer_id: 'double-spender',
    raw_event_json: JSON.stringify(options.rawEvent ?? makeJob(jobId).rawEvent),
    created_at: now,
  });
  // A full request, matching what a real provider persists.
  targetLedger.updatePayment(
    jobId,
    undefined,
    JSON.stringify(
      paymentRequestFixture({
        createdAt: options.createdAt ?? (options.stillOpen === true ? now : now - 700),
        expirySecs: options.expirySecs,
      }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sigPathVerify = (txSignature: string) => ({ verified: true, txSignature });
  refPathVerify = (candidateSignature?: string) => ({
    verified: true,
    txSignature: candidateSignature ?? SHARED_SIGNATURE,
  });
  refScanEntries = [{ signature: REF_SCAN_CANDIDATE }];
  refScanFailure = null;
  refScanTransientFailures = 0;
  refScanListDelayMs = 0;
  refScanCalls = 0;
  refScanOnAttempt = null;
  refScanTimestamps = [];
  refScanCommitments = [];
  refScanLimits = [];
  verifyCalls = [];
  genesisHash = CLUSTER_GENESIS_HASHES.devnet;
  genesisFailure = null;
  genesisThrowsSynchronously = false;
  genesisCalls = 0;
  historyProbeFailure = null;
  listedAddresses = [];
  logs = [];
  agentDir = mkdtempSync(join(tmpdir(), 'elisym-dedup-test-'));
  ledgerPath = join(agentDir, '.jobs.json');
  ledger = new JobLedger(ledgerPath);
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe('one settlement transaction settles one job', () => {
  it('signature path: the second job reporting the same signature is never delivered', async () => {
    const skill = makePaidSkill();
    const { transport, triggerJob } = makeFakeTransport(always(SHARED_SIGNATURE));
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('dedup-first'));
    await waitFor(() => ledger.getStatus('dedup-first') === 'delivered', 'first job delivered');
    triggerJob(makeJob('dedup-second'));
    await waitFor(
      () => errorMessages(transport, 'dedup-second').length > 0,
      'second job resolved with an error',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(deliveredJobIds(transport)).toEqual(['dedup-first']);
    // The second job verified on-chain exactly as the first did, but its
    // settlement was already consumed - so it is NOT paid and never executes.
    expect(ledger.getStatus('dedup-second')).not.toBe('delivered');
    expect(skill.execute).toHaveBeenCalledTimes(1);
  });

  it('reference-scan path: the second job is refused there too', async () => {
    const skill = makePaidSkill();
    // No payment-completed feedback: the reference scan is the only way in.
    const { transport, triggerJob } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('ref-first'));
    await waitFor(() => ledger.getStatus('ref-first') === 'delivered', 'first job delivered');
    triggerJob(makeJob('ref-second'));
    await waitFor(
      () => errorMessages(transport, 'ref-second').length > 0,
      'second job resolved with an error',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(deliveredJobIds(transport)).toEqual(['ref-first']);
    expect(skill.execute).toHaveBeenCalledTimes(1);
  });

  it('two CONCURRENT jobs on one signature: exactly one is paid', async () => {
    const skill = makePaidSkill();
    const { transport, triggerJob } = makeFakeTransport(always(SHARED_SIGNATURE));
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    // Both enter the verify race in the same tick - the ledger's check-and-mark
    // is synchronous, so exactly one of them can win.
    triggerJob(makeJob('race-a'));
    triggerJob(makeJob('race-b'));
    await waitFor(
      () =>
        deliveredJobIds(transport).length === 1 &&
        errorMessages(transport, 'race-a').length + errorMessages(transport, 'race-b').length > 0,
      'one job delivered and the other refused',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(deliveredJobIds(transport)).toHaveLength(1);
    expect(skill.execute).toHaveBeenCalledTimes(1);
  });

  it('the refused job gets the same customer-facing failure as an unverified payment', async () => {
    const skill = makePaidSkill();
    const { transport, triggerJob } = makeFakeTransport(always(SHARED_SIGNATURE));
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('feedback-first'));
    await waitFor(() => ledger.getStatus('feedback-first') === 'delivered', 'first job delivered');
    triggerJob(makeJob('feedback-second'));
    await waitFor(
      () => errorMessages(transport, 'feedback-second').length > 0,
      'second job resolved with the usual customer-facing failure',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    // Identical to any other job whose payment window elapsed inconclusively -
    // and it must not disclose that another job exists, let alone which one.
    // It must also read as "no payment arrived", never as an agent malfunction:
    // `PaymentTimeoutError`'s message has to keep matching the customer-safe
    // allowlist or every unpaid customer is told the provider broke.
    // Exactly ONE, and it is the explanatory one. A targeted customer's
    // subscription closes on the FIRST error feedback it sees, so a second
    // feedback is not merely noise - whichever one is published first is the
    // only one that ever reaches a browser.
    const messages = errorMessages(transport, 'feedback-second');
    expect(messages).toEqual([PAYMENT_TIMEOUT_CUSTOMER_MESSAGE]);
    // Cross-package contract, pinned here because the web app cannot import it:
    // the app reads this prefix as "the payment is still being looked for" and
    // is the only place a paying customer is told their money is not lost. The
    // same prefix is what keeps the message off the sanitiser's generic mask.
    expect(PAYMENT_TIMEOUT_CUSTOMER_MESSAGE.startsWith('Payment timeout')).toBe(true);
    expect(messages).not.toContain('The agent could not complete this job.');
    expect(messages.join(' ')).not.toContain('feedback-first');
    expect(messages.join(' ')).not.toContain(SHARED_SIGNATURE);
    expect(deliveredJobIds(transport)).not.toContain('feedback-second');
  });

  it('the LIVE signature path claims what it ASKED about, not the strategy`s echo', async () => {
    // The same rule the recovery scan follows, on the path the scan does not
    // cover. The customer asserted GENUINE; a buggy (or hostile) strategy echoes
    // back some other transaction. Binding the de-duplication claim to the echo
    // would let a strategy point this job's settlement at a transaction the job
    // never asked about - and, worse, at one another job is entitled to.
    sigPathVerify = () => ({ verified: true, txSignature: SHARED_SIGNATURE });
    refPathVerify = () => ({ verified: false, error: DEFINITIVE_NO_PAYMENT });
    const skill = makePaidSkill();
    const { transport, triggerJob } = makeFakeTransport(always(GENUINE_SIGNATURE));
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('asked-not-echoed'));
    await waitFor(
      () => ledger.getStatus('asked-not-echoed') === 'delivered',
      'the job delivered on the signature it asked about',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(ledger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('asked-not-echoed');
    expect(ledger.paymentSignatureOwner(SHARED_SIGNATURE)).toBeUndefined();
  });

  it('a customer who pays TWICE does not have the winning settlement released', async () => {
    // Both live verify paths succeed, with DIFFERENT transactions - an ordinary
    // customer who paid, did not see the confirmation, and paid again. The first
    // to arrive settles the job. The loser must not go on to claim as well: a
    // second claim by the same job RELEASES the first one's index mark (the entry
    // holds exactly one `payment_signature`), so the transaction that actually
    // settled this job would become unowned and available to the next job that
    // finds it on a shared reference.
    let refPathAccepted = false;
    sigPathVerify = (txSignature: string) => ({ verified: true, txSignature });
    refPathVerify = async () => {
      await tick(120); // the signature path wins the race
      refPathAccepted = true;
      return { verified: true, txSignature: SHARED_SIGNATURE };
    };
    const skill = makePaidSkill();
    const { transport, triggerJob } = makeFakeTransport(always(GENUINE_SIGNATURE));
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('paid-twice'));
    await waitFor(() => ledger.getStatus('paid-twice') === 'delivered', 'the first payment won');
    await waitFor(() => refPathAccepted, 'the second payment also verified');
    await tick(50);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(ledger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('paid-twice');
    expect(ledger.paymentSignatureOwner(SHARED_SIGNATURE)).toBeUndefined();
    const entry = ledger.allEntries().find((candidate) => candidate.job_id === 'paid-twice');
    expect(entry?.payment_signature).toBe(GENUINE_SIGNATURE);
    expect(skill.execute).toHaveBeenCalledOnce();
  });

  it('a verification with no settlement signature is refused, not accepted', async () => {
    // Guard: a verification we cannot name cannot be de-duplicated. Every real
    // SDK success carries its signature, so this is a broken strategy, not a
    // customer state - fail closed rather than accept an unnameable payment.
    //
    // Driven through the SDK's own REFERENCE path, because that is the only path
    // that can reach this branch: the signature path asks about a specific
    // transaction and claims THAT one, named or not (see the `asked-not-echoed`
    // test above). So: no payment-completed feedback, and a reference path that
    // reports success without naming anything.
    refPathVerify = () => ({ verified: true });
    const skill = makePaidSkill();
    const { transport, triggerJob } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('nameless-settlement'));
    await waitFor(
      () => errorMessages(transport, 'nameless-settlement').length > 0,
      'job resolved with an error',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).not.toHaveBeenCalled();
    expect(deliveredJobIds(transport)).toEqual([]);
  });

  it('a verification naming an EMPTY settlement is refused the same way', async () => {
    // Same branch, the value that actually reaches it in the field. The
    // reference path asks about no signature, so whatever the answer carries is
    // what would be claimed - and a proxy rewriting an RPC page carries an
    // empty string, not `undefined`. A claim keyed on one owns nothing: the
    // ledger index drops it, the transaction it stood for stays free for the
    // next job carrying this reference, and the job is marked paid regardless.
    refPathVerify = () => ({ verified: true, txSignature: '' });
    const skill = makePaidSkill();
    const { transport, triggerJob } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('blank-settlement'));
    await waitFor(
      () => errorMessages(transport, 'blank-settlement').length > 0,
      'job resolved with an error',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).not.toHaveBeenCalled();
    expect(deliveredJobIds(transport)).toEqual([]);
    const entry = ledger.allEntries().find((candidate) => candidate.job_id === 'blank-settlement');
    expect(entry?.payment_signature).toBeUndefined();
  });
});

describe("a refused settlement never ends an honest customer's job", () => {
  /**
   * The payment request, reference included, is published in cleartext on
   * public relays and the verifier never binds the payer, so anyone can attach
   * someone else's reference to their own transfer. `consumed-by-other`
   * therefore means "this transaction is not attributable to this job", NOT
   * "the customer abandoned it".
   */
  it('leaves the entry recoverable instead of concluding non-payment', async () => {
    seedConsumedSettlement(ledger, 'stranger-job', SHARED_SIGNATURE);
    const skill = makePaidSkill();
    // No payment-completed feedback at all, and the reference scan only finds
    // the stranger's already-consumed transaction.
    const { transport, triggerJob } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('griefed'));
    await waitFor(
      () => errorMessages(transport, 'griefed').includes(PAYMENT_TIMEOUT_CUSTOMER_MESSAGE),
      'job resolved as an ordinary payment timeout',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    // Left `paid` for recovery, not force-failed on a stranger's transaction.
    expect(ledger.getStatus('griefed')).toBe('paid');
    expect(skill.execute).not.toHaveBeenCalled();
  });

  it('releases the concurrency slot as soon as both verify paths have lost', async () => {
    // Both verify paths are one-shot, so once both have lost nothing can still
    // resolve - holding the slot to the deadline would let ONE transaction
    // carrying N references pin N provider slots for the whole window.
    seedConsumedSettlement(ledger, 'stranger-job', SHARED_SIGNATURE);
    const skill = makePaidSkill();
    const { transport, triggerJob } = makeFakeTransport((jobId) =>
      jobId === 'honest' ? { signature: GENUINE_SIGNATURE } : { signature: null },
    );
    const runtime = makeRuntime(skill, transport, ledger, { maxConcurrentJobs: 1 });

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('griefed'));
    triggerJob(makeJob('honest'));

    // `honest` can only start once `griefed` has given the single slot back.
    await waitFor(
      () => deliveredJobIds(transport).includes('honest'),
      'the queued honest job ran well inside the payment window',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(ledger.getStatus('griefed')).toBe('paid');
    expect(ledger.getStatus('honest')).toBe('delivered');
  });

  it('a genuine later payment for the same job still verifies and is delivered', async () => {
    seedConsumedSettlement(ledger, 'stranger-job', SHARED_SIGNATURE);
    const skill = makePaidSkill();
    // The victim's reference scan finds only the stranger's consumed transfer,
    // but the customer's own `payment-completed` arrives a moment later.
    const { transport, triggerJob } = makeFakeTransport(
      always(GENUINE_SIGNATURE, PAYMENT_WINDOW_MS / 8),
    );
    const runtime = makeRuntime(skill, transport);

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob('late-pay-victim'));
    await waitFor(
      () => ledger.getStatus('late-pay-victim') === 'delivered',
      'the genuine later payment won',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).toHaveBeenCalledOnce();
    expect(deliveredJobIds(transport)).toEqual(['late-pay-victim']);
  });
});

describe('settlement de-duplication survives a restart', () => {
  it('a fresh process reloads the ledger and still refuses the consumed signature', async () => {
    const firstSkill = makePaidSkill();
    const first = makeFakeTransport(always(SHARED_SIGNATURE));
    const firstRuntime = makeRuntime(firstSkill, first.transport);

    const firstRun = firstRuntime.run();
    await tick();
    first.triggerJob(makeJob('boot1-job'));
    await waitFor(() => ledger.getStatus('boot1-job') === 'delivered', 'first boot delivered');
    firstRuntime.stop();
    await firstRun.catch(() => {});

    // Restart: a new ledger instance over the same file rebuilds the index from
    // the persisted `payment_signature` - there is no separate store to lose.
    const rebootLedger = new JobLedger(ledgerPath);
    expect(rebootLedger.paymentSignatureOwner(SHARED_SIGNATURE)).toBe('boot1-job');

    const secondSkill = makePaidSkill();
    const second = makeFakeTransport(always(SHARED_SIGNATURE));
    const secondRuntime = makeRuntime(secondSkill, second.transport, rebootLedger);

    const secondRun = secondRuntime.run();
    await tick();
    second.triggerJob(makeJob('boot2-job'));
    await waitFor(
      () => errorMessages(second.transport, 'boot2-job').length > 0,
      'second boot job resolved with an error',
    );
    secondRuntime.stop();
    await secondRun.catch(() => {});

    expect(secondSkill.execute).not.toHaveBeenCalled();
    expect(deliveredJobIds(second.transport)).toEqual([]);
  });
});

describe('crash recovery', () => {
  it('a re-claim by the same job succeeds after a restart', async () => {
    recordCrashedPaidJob(ledger, 'recover-self');
    expect(ledger.claimPaymentSignature(SHARED_SIGNATURE, 'recover-self')).toBe('claimed');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('recover-self') === 'delivered',
      'the job re-claimed its own settlement and delivered',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).toHaveBeenCalledOnce();
  });

  it('re-verifies the settlement this job already claimed, before any reference scan', async () => {
    // The job claimed its settlement and crashed before `updatePayment`. The
    // newest transaction on the reference is now a stranger's consumed transfer
    // - so recovery must ask about this job's OWN evidence first, rather than
    // spend the scan on a transaction the ledger already gave to someone else.
    seedConsumedSettlement(ledger, 'stranger-job', SHARED_SIGNATURE);
    refScanEntries = [{ signature: SHARED_SIGNATURE }];
    recordCrashedPaidJob(ledger, 'crashed-after-claim');
    expect(ledger.claimPaymentSignature(OWN_CLAIMED_SIGNATURE, 'crashed-after-claim')).toBe(
      'claimed',
    );

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 1 });

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('crashed-after-claim') === 'delivered',
      'the already-claimed settlement was re-verified and the job delivered',
      NEXT_TICK_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).toHaveBeenCalledOnce();
    expect(rebootLedger.paymentSignatureOwner(OWN_CLAIMED_SIGNATURE)).toBe('crashed-after-claim');
  });

  it('does not skip its OWN settlement when the scan meets it again', async () => {
    // The scan looks past signatures the ledger has already handed out - but
    // "handed out" has to mean to ANOTHER job. Here the mark on the reference's
    // only transaction belongs to this very job, and a flaky moment made the
    // dedicated own-settlement re-verify come back empty-handed, so the scan is
    // the last path to the customer's real payment. Skipping our own mark there
    // throws away the one thing the scan can still do for this entry: ask again,
    // in a different moment, with the scan's own retry budget. Asserted within a
    // SINGLE pass, because that is where the difference lives - the job is paid
    // either way, and a later tick's own-settlement re-verify would eventually
    // deliver it, so a test that merely waits proves nothing.
    refScanEntries = [{ signature: OWN_CLAIMED_SIGNATURE }];
    recordCrashedPaidJob(ledger, 'own-candidate');
    expect(ledger.claimPaymentSignature(OWN_CLAIMED_SIGNATURE, 'own-candidate')).toBe('claimed');

    // First look - the own-settlement re-verify - fails; the scan's look lands.
    let looks = 0;
    refPathVerify = (candidateSignature?: string) => {
      looks += 1;
      return looks === 1
        ? { verified: false, error: 'Verification failed after 2 retries: 429 Too Many Requests' }
        : { verified: true, txSignature: candidateSignature ?? OWN_CLAIMED_SIGNATURE };
    };

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // 999s: there is exactly ONE recovery pass in this test, the one at startup.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('own-candidate') === 'delivered',
      'the same pass verified the job`s own settlement instead of skipping it',
      NEXT_TICK_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});

    // Two looks at the same signature: the own-settlement one, then the scan's.
    expect(looks).toBeGreaterThanOrEqual(2);
    expect(skill.execute).toHaveBeenCalledOnce();
    expect(rebootLedger.paymentSignatureOwner(OWN_CLAIMED_SIGNATURE)).toBe('own-candidate');
  }, 30_000);

  it('never fails a job because ANOTHER job consumed the only transaction on its reference', async () => {
    // The attacker settles their own job with a transfer that also carries the
    // victim's reference. Concluding "unpaid" here would kill a job the customer
    // may well have paid for, so recovery defers and keeps looking.
    seedConsumedSettlement(ledger, 'stranger-job', SHARED_SIGNATURE);
    refScanEntries = [{ signature: SHARED_SIGNATURE }];
    recordCrashedPaidJob(ledger, 'recovery-victim');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 1 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery ran its reference scan');

    // Not terminal, and not a burned retry either - the same retry-free skip as
    // the LLM-health and preflight gates.
    expect(rebootLedger.getStatus('recovery-victim')).toBe('paid');
    expect(retryCount(rebootLedger, 'recovery-victim')).toBe(0);
    expect(skill.execute).not.toHaveBeenCalled();

    // The customer's genuine transfer surfaces on a later scan.
    refScanEntries = [{ signature: GENUINE_SIGNATURE }, { signature: SHARED_SIGNATURE }];
    await waitFor(
      () => rebootLedger.getStatus('recovery-victim') === 'delivered',
      'the genuine payment was found on a later tick and the job delivered',
      BACKOFF_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).toHaveBeenCalledOnce();
    expect(rebootLedger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('recovery-victim');
  });

  it('delivers the MASKED victim: looks past a consumed newer transaction to its own older one', async () => {
    // The central failure this whole rail exists to prevent. The attacker's
    // transfer carries the victim's reference and is NEWER, so a scan that can
    // only see the first transaction that verifies is stuck on it forever: the
    // victim's genuine, older payment is never returned, every tick defers, and
    // at 24h the job is force-failed with the customer's money already taken.
    // Enumerating candidates provider-side is what makes the older one reachable.
    seedConsumedSettlement(ledger, 'stranger-job', SHARED_SIGNATURE);
    refScanEntries = [
      { signature: SHARED_SIGNATURE }, // newest, consumed by the stranger
      { signature: GENUINE_SIGNATURE }, // the victim's own, behind it
    ];
    recordCrashedPaidJob(ledger, 'masked-victim');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('masked-victim') === 'delivered',
      'the victim`s own older payment was found behind the consumed one',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).toHaveBeenCalledOnce();
    expect(rebootLedger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('masked-victim');
    // The stranger keeps their settlement - we looked PAST it, we did not steal it.
    expect(rebootLedger.paymentSignatureOwner(SHARED_SIGNATURE)).toBe('stranger-job');
  });

  it('finds the real payment behind a window full of junk transactions', async () => {
    // Anyone can put transactions on a reference: it is published in cleartext.
    // The SDK's reference path returns the first candidate that verifies and
    // cannot be asked for the next, so junk that does not verify hides the
    // genuine payment from it. Walking the whole window is what finds it - and
    // a FULL window (25 here) is walked exactly like a short one: `windowFull`
    // only disqualifies the terminal verdict, it must never stop the search.
    const flood = Array.from({ length: 24 }, (_value, index) => ({
      signature: `junk-${index}`,
    }));
    refScanEntries = [...flood, { signature: GENUINE_SIGNATURE }];
    refPathVerify = (candidateSignature?: string) =>
      candidateSignature === GENUINE_SIGNATURE
        ? { verified: true, txSignature: GENUINE_SIGNATURE }
        : { verified: false, error: 'Recipient balance did not increase by the expected amount' };
    recordCrashedPaidJob(ledger, 'flooded');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('flooded') === 'delivered',
      'the genuine payment was found past the flood',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).toHaveBeenCalledOnce();
    expect(rebootLedger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('flooded');
  });

  it('reads ONE window per scan and asks for it at `confirmed`', async () => {
    // Two properties of the listing in one place.
    //   WINDOW: the scan is a single `getSignaturesForAddress` call. Paging
    //   raised the flood threshold from 25 to 100 transactions - pennies for an
    //   attacker either way - at the price of a verify loop four times longer,
    //   holding a slot shared with live intake.
    //   COMMITMENT: the RPC default is `finalized`, but the verifier reads
    //   transactions at `confirmed`. Listing at the stricter level would hide a
    //   confirmed-but-not-finalized payment from the check that decides whether
    //   anything is there at all.
    refScanEntries = Array.from({ length: 500 }, (_value, index) => ({
      signature: `endless-${index}`,
    }));
    refPathVerify = () => ({ verified: false, error: 'Recipient balance did not increase' });
    recordCrashedPaidJob(ledger, 'one-window');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery ran its reference scan');
    await tick(100);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(refScanCalls).toBe(1);
    expect(refScanLimits).toEqual([REFERENCE_SCAN_WINDOW]);
    // The window IS the SDK's own, not a private copy that can drift from it.
    // The provider's advantage over the SDK's reference path is knowing which
    // signatures its ledger already spent, not reading a different page.
    expect(REFERENCE_SCAN_WINDOW).toBe(DEFAULTS.VERIFY_SIGNATURE_LIMIT);
    expect(refScanCommitments).toEqual(['confirmed']);
    expect(rebootLedger.getStatus('one-window')).toBe('paid');
  });

  it('a reference carrying ONLY failed transactions is "no payment", not a 24h wait', async () => {
    // A transaction that failed on chain moved nothing, so it can never be a
    // payment AND it is no evidence that anyone touched this reference. Counting
    // it would let ~5000 lamports of deliberately-failing transaction - or an
    // honest customer whose transfer simply failed - turn a job that should
    // close in a minute into an entry that waits out the 24h cutoff.
    refScanEntries = [{ signature: 'failed-tx', failed: true }];
    const verifiedCandidates: string[] = [];
    refPathVerify = (candidateSignature?: string) => {
      verifiedCandidates.push(candidateSignature ?? '<bare>');
      return { verified: true, txSignature: candidateSignature };
    };
    recordCrashedPaidJob(ledger, 'failed-tx-only');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // The terminal verdict needs a SECOND consecutive clean scan, so the close
    // happens on a later tick, not on the first. Driven tick by tick: the wait
    // between those two is deliberately long and has its own test.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the first scan ran');
    await drainRecovery(runtime);
    expect(rebootLedger.getStatus('failed-tx-only')).toBe('paid');
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.getStatus('failed-tx-only')).toBe('failed');

    // The failed transaction is never even fetched - it cannot be a payment.
    expect(verifiedCandidates).toEqual([]);
    expect(skill.execute).not.toHaveBeenCalled();
  });

  it('never closes a paid job on ONE empty scan - it takes two consecutive ones', async () => {
    // The public RPC throttles and lags this exact address index, so a single
    // empty listing is not worth a customer's money. A false deferral costs
    // latency; a false "unpaid" destroys the payment.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'one-empty-scan');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // 999s interval: only the startup tick runs inside this test.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery ran its reference scan');
    await tick(100);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.getStatus('one-empty-scan')).toBe('paid');
    expect(retryCount(rebootLedger, 'one-empty-scan')).toBe(0);
    expect(logged(/confirming on the next attempt/)).toBe(true);
  });

  it('a scan that SKIPPED a consumed candidate is never terminal, however often it repeats', async () => {
    // Condition 3 of the terminal verdict. A skip means something did touch this
    // reference and we chose not to look at it - the scan saw less than the
    // whole truth, so repeating it can never add up to "the customer never
    // paid". Without this, an attacker who parks one consumed transaction on a
    // victim's reference gets the job closed in two ticks.
    seedConsumedSettlement(ledger, 'stranger-job', SHARED_SIGNATURE);
    refScanEntries = [{ signature: SHARED_SIGNATURE }];
    recordCrashedPaidJob(ledger, 'skip-forever');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 1 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls >= 2, 'recovery scanned at least twice', BACKOFF_MS);
    await tick(100);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.getStatus('skip-forever')).toBe('paid');
    expect(skill.execute).not.toHaveBeenCalled();
  });

  it('a FULL window is never terminal - a payment could be hiding behind the flood', async () => {
    // Condition 1. A window that came back at the limit is a truncated page, so
    // "nothing verified" says nothing about what is behind it. Anyone can fill a
    // public reference with cheap transactions; reading that as non-payment
    // would hand an attacker a way to close a paid job.
    refScanEntries = Array.from({ length: REFERENCE_SCAN_WINDOW }, (_value, index) => ({
      signature: `flood-${index}`,
    }));
    refPathVerify = () => ({ verified: false, error: 'Recipient balance did not increase' });
    recordCrashedPaidJob(ledger, 'flooded-window');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 1 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls >= 2, 'recovery scanned at least twice', BACKOFF_MS);
    await tick(100);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.getStatus('flooded-window')).toBe('paid');
    expect(logged(/truncated and a payment could be hidden behind the flood/)).toBe(true);
  });

  it('a candidate that does not verify is NEVER terminal, however often it repeats', async () => {
    // Clause 2 of the terminal verdict. The SDK reports "I fetched this
    // transaction and it is not a payment for this request" and "I could not
    // reach the chain for this transaction" as the SAME `{verified: false,
    // error}`, so a candidate that fails to verify can always be a throttled
    // RPC - and an unreachable RPC must never be evidence of non-payment.
    // Repeating it can therefore never add up to "the customer never paid".
    refScanEntries = [{ signature: 'real-but-unverifiable' }];
    refPathVerify = () => ({ verified: false, error: 'Recipient balance did not increase' });
    recordCrashedPaidJob(ledger, 'unverifiable-candidate');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery ran its reference scan');
    await drainRecovery(runtime);
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(refScanCalls).toBeGreaterThanOrEqual(3);
    expect(skill.execute).not.toHaveBeenCalled();
    expect(rebootLedger.getStatus('unverifiable-candidate')).toBe('paid');
    expect(retryCount(rebootLedger, 'unverifiable-candidate')).toBe(0);
    // A distinct reason from "we could not reach the chain": both are
    // inconclusive, but thirty identical lines a day would otherwise tell an
    // operator nothing about which of the two they are looking at.
    expect(logged(/did not verify as a payment for this job/)).toBe(true);
    expect(logged(/could not reach the chain/)).toBe(false);
  });

  it('gives a scan candidate a SMALL retry budget, and the job`s own settlement a larger one', async () => {
    // A candidate is a guess. At the SDK default of 10 retries x 3s it costs up
    // to 30s each and ~12 minutes across a full window, all of it holding a
    // `p-limit` slot shared with live intake. The single signature the job
    // already owns is a known payment and gets more - but NOT the SDK default,
    // which would spend 30s of that shared slot on every single tick once the
    // settlement has aged out of the RPC's history window.
    refScanEntries = [{ signature: REF_SCAN_CANDIDATE }];
    refPathVerify = () => ({ verified: false, error: 'Recipient balance did not increase' });
    sigPathVerify = () => ({ verified: false, error: 'Transaction not found' });
    recordCrashedPaidJob(ledger, 'budgeted');
    expect(ledger.claimPaymentSignature(OWN_CLAIMED_SIGNATURE, 'budgeted')).toBe('claimed');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery ran its reference scan');
    await tick(50);
    runtime.stop();
    await runPromise.catch(() => {});

    const ownRecheck = verifyCalls.find((call) => call.txSignature === OWN_CLAIMED_SIGNATURE);
    const candidate = verifyCalls.find((call) => call.txSignature === REF_SCAN_CANDIDATE);
    expect(candidate?.retries).toBe(REFERENCE_SCAN_VERIFY_RETRIES);
    expect(ownRecheck?.retries).toBe(OWN_SETTLEMENT_VERIFY_RETRIES);
    // A candidate gets THE SAME budget as the listing that found it. Fewer would
    // make a throttled RPC look like evidence: the verifier reports "not a
    // payment" and "could not reach the chain" identically, so an under-funded
    // candidate check is an under-funded chain check. The expectation is pinned
    // to the LISTING budget, not to the candidate constant, so cutting the
    // candidate budget alone cannot slip through.
    expect(REFERENCE_SCAN_VERIFY_RETRIES).toBe(REFERENCE_SCAN_LIST_ATTEMPTS);
    // Bounded, and strictly more generous than a guess - never the SDK default.
    expect(ownRecheck?.retries).toBeGreaterThan(REFERENCE_SCAN_VERIFY_RETRIES);
    expect(ownRecheck?.retries).toBeLessThan(10);
  });

  it('abandons a scan that runs past its wall-clock deadline', async () => {
    // A rate-limited RPC must not hold a shared slot for minutes. The scan
    // returns inconclusive once its budget is spent; the entry stays `paid`.
    refScanEntries = [{ signature: 'slow-1' }, { signature: 'slow-2' }, { signature: 'slow-3' }];
    const realNow = Date.now;
    let clockSkewMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockSkewMs);
    const verifiedCandidates: string[] = [];
    refPathVerify = (candidateSignature?: string) => {
      verifiedCandidates.push(candidateSignature ?? '<bare>');
      clockSkewMs += 31_000; // one candidate ate the whole scan budget
      return { verified: false, error: 'Verification failed after 1 retries: 429' };
    };
    recordCrashedPaidJob(ledger, 'slow-scan');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await tick(200);
    runtime.stop();
    await runPromise.catch(() => {});
    nowSpy.mockRestore();

    // It stopped after the first candidate instead of walking all three.
    expect(verifiedCandidates).toEqual(['slow-1']);
    expect(rebootLedger.getStatus('slow-scan')).toBe('paid');
    expect(skill.execute).not.toHaveBeenCalled();
  });

  it('an empty scan NEVER outranks a settlement this job already owns', async () => {
    // The job's own settlement no longer verifies (the RPC has aged it out of
    // its history window) and the reference lists nothing. The ledger still
    // says this job was paid, which is better evidence than an RPC's amnesia -
    // force-failing here would end a job we ourselves recorded as settled.
    recordCrashedPaidJob(ledger, 'owns-but-invisible');
    expect(ledger.claimPaymentSignature(OWN_CLAIMED_SIGNATURE, 'owns-but-invisible')).toBe(
      'claimed',
    );
    refScanEntries = [];
    sigPathVerify = () => ({ verified: false, error: 'Transaction not found' });

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // 999s interval, driven tick by tick: the empty-scan verdict needs TWO
    // consecutive sightings, so one tick proves nothing here - a job that owns a
    // settlement has to survive however many empty scans the RPC serves up.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery ran its reference scan');
    await drainRecovery(runtime);
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(refScanCalls).toBeGreaterThanOrEqual(3);
    expect(rebootLedger.getStatus('owns-but-invisible')).toBe('paid');
    expect(retryCount(rebootLedger, 'owns-but-invisible')).toBe(0);
    expect(skill.execute).not.toHaveBeenCalled();
    expect(logged(/treating the empty scan as an RPC history gap/)).toBe(true);
  });

  it('TWO consecutive complete empty scans ARE terminal', async () => {
    // The one outcome that still fails the job: two consecutive clean scans of
    // the reference's whole history that found nothing.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'recover-unpaid');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // Driven tick by tick rather than raced against the interval: the wait
    // BETWEEN the two closing scans is deliberately long (see the floor in
    // `TERMINAL_CONFIRMATION_MIN_RUNG`, covered by its own test), and what is
    // under test here is that two of them are needed and sufficient.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the first empty scan ran');
    await drainRecovery(runtime);
    expect(rebootLedger.getStatus('recover-unpaid')).toBe('paid');
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.getStatus('recover-unpaid')).toBe('failed');

    expect(skill.execute).not.toHaveBeenCalled();
    expect(refScanCalls).toBeGreaterThanOrEqual(2);
    expect(logged(/two consecutive complete scans found no payment/)).toBe(true);
    // The customer is told, once, and told what actually happened.
    const notice = errorMessages(transport, 'recover-unpaid');
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatch(/no payment for this job was found on-chain/);
  });

  it('a request whose created_at is not a positive timestamp gets a full default window', async () => {
    // The gate reads the request's OWN `created_at`. A hand-edited or
    // half-written ledger can carry `0` (or a negative), and `0 + expiry_secs`
    // is an instant in 1970 - so without the positive-timestamp guard the gate
    // is satisfied the moment recovery looks, and the job is closed as unpaid on
    // the second scan with no window at all. The fallback (the job's own
    // acceptance time) always EXTENDS the wait.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'zero-created-at', { createdAt: 0 });

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the empty scan ran');
    await drainRecovery(runtime);
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(refScanCalls).toBeGreaterThanOrEqual(3);
    expect(rebootLedger.getStatus('zero-created-at')).toBe('paid');
    expect(errorMessages(transport, 'zero-created-at')).toEqual([]);
    expect(logged(/does not expire for another \d+s/)).toBe(true);
  }, 30_000);

  it('a request whose expiry_secs is not positive gets the SDK default window', async () => {
    // The other half of the same guard. `expiry_secs: 0` would make the window
    // zero-length, so a request minted this second would already be "expired"
    // and a customer who is still confirming in their wallet loses the job.
    refScanEntries = [];
    const now = Math.floor(Date.now() / 1000);
    recordCrashedPaidJob(ledger, 'zero-expiry', { createdAt: now, expirySecs: 0 });

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the empty scan ran');
    await drainRecovery(runtime);
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.getStatus('zero-expiry')).toBe('paid');
    expect(logged(/does not expire for another \d+s/)).toBe(true);
  }, 30_000);

  it('never closes a job before the payment request it issued has EXPIRED', async () => {
    // The live verify race resolves as soon as both of its one-shot paths have
    // lost - seconds, not the advertised window - so without this gate two
    // recovery ticks could close a request that still had minutes to run. A
    // customer who confirms in their wallet at two minutes of a ten-minute
    // window would be failed before their payment could even be expected.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'still-in-window', { stillOpen: true });

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'tick 1: the empty scan ran');
    await drainRecovery(runtime);
    // However many empty scans it takes, the verdict cannot land yet - and the
    // empty sighting is not even banked, so the count starts after the expiry.
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(refScanCalls).toBeGreaterThanOrEqual(3);
    expect(rebootLedger.getStatus('still-in-window')).toBe('paid');
    expect(runtime.recoveryDeferrals.sawNoPayment('still-in-window')).toBe(false);
    expect(errorMessages(transport, 'still-in-window')).toEqual([]);
    expect(logged(/does not expire for another \d+s/)).toBe(true);
  }, 30_000);

  it('keeps an entry inside its window at the BOTTOM of the backoff ladder', async () => {
    // The companion to the unit test on `noteAwaitingWindow`: proves the runtime
    // actually routes this outcome there. Three empty scans inside the window
    // leave the ladder untouched, so the entry is still due every tick - which is
    // what lets a customer who confirms at minute eight be found at minute nine
    // instead of waiting out a rung they did not cause.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'window-open', { stillOpen: true });

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the first empty scan ran');
    await drainRecovery(runtime);
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);

    expect(runtime.recoveryDeferrals.peek('window-open')?.attempts).toBe(0);

    // The customer pays, still inside their window: the very next tick finds it.
    refScanEntries = [{ signature: GENUINE_SIGNATURE }];
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.getStatus('window-open')).toBe('delivered');
    expect(rebootLedger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('window-open');
  }, 30_000);

  it('a request with no usable timestamps still gets a full default window', async () => {
    // A ledger written by an older build (or hand-edited) carries no
    // `created_at`/`expiry_secs`. "We cannot tell when this expired" must never
    // resolve to "it has expired": the fallback is the job's own acceptance time
    // plus the SDK's default window, which always extends the wait.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'timeless-request');
    ledger.updatePayment(
      'timeless-request',
      undefined,
      JSON.stringify({ reference: PAYMENT_REFERENCE }),
    );

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the empty scan ran');
    await drainRecovery(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.getStatus('timeless-request')).toBe('paid');
    expect(logged(/does not expire for another \d+s/)).toBe(true);
  }, 30_000);

  it('an inconclusive scan between two empty ones RESTARTS the count', async () => {
    // "Two CONSECUTIVE" is the whole guarantee. If an RPC outage in between did
    // not clear the flag, a single empty listing either side of an outage would
    // add up to a terminal verdict on a job the chain was never properly asked
    // about. Driven tick by tick so the sequence is exact, not a race.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'interrupted-count');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // 999s interval: `run()`'s startup pass is tick 1 and nothing else fires.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'tick 1: the first empty scan ran');
    await drainRecovery(runtime);
    expect(rebootLedger.getStatus('interrupted-count')).toBe('paid');

    // Tick 2: the chain is unreachable. This must CLEAR the empty sighting.
    refScanFailure = new Error('503 Service Unavailable');
    await runRecoveryTick(runtime);
    expect(rebootLedger.getStatus('interrupted-count')).toBe('paid');

    // Tick 3: empty again - the first of a NEW pair, so still not terminal.
    refScanFailure = null;
    await runRecoveryTick(runtime);
    expect(rebootLedger.getStatus('interrupted-count')).toBe('paid');

    // Tick 4: the second consecutive empty scan closes it.
    await runRecoveryTick(runtime);
    expect(rebootLedger.getStatus('interrupted-count')).toBe('failed');

    runtime.stop();
    await runPromise.catch(() => {});
    expect(skill.execute).not.toHaveBeenCalled();
  }, 20_000);

  it('fails FAST on our own corrupt state instead of waiting out the 24h cutoff', async () => {
    // A `payment_request` that is not JSON can never verify. Deferring it for a
    // day only holds a slot and its session registration, and buries the real
    // problem under 1440 identical "could not confirm" lines.
    recordCrashedPaidJob(ledger, 'corrupt-request');
    ledger.updatePayment('corrupt-request', undefined, '{not json at all');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('corrupt-request') === 'failed',
      'the unusable entry was closed on the FIRST tick',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    // Never even asked the chain: there was nothing to ask about.
    expect(refScanCalls).toBe(0);
    expect(logged(/persisted payment request is unusable/)).toBe(true);
    expect(skill.execute).not.toHaveBeenCalled();
    // The CUSTOMER is told. A silent `markFailed` leaves someone who may well
    // have paid watching a job that will never answer - and the notice does not
    // accuse them of not paying, because nobody here knows that.
    const notice = errorMessages(transport, 'corrupt-request');
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatch(/could not verify payment/);
    expect(notice[0]).toMatch(/contact the provider with your transaction signature/);
  });

  it('fails FAST when the persisted reference is not an address', async () => {
    // Same class of problem, one level in: the JSON parses but its reference
    // can never be passed to `getSignaturesForAddress`.
    recordCrashedPaidJob(ledger, 'corrupt-reference');
    ledger.updatePayment(
      'corrupt-reference',
      undefined,
      JSON.stringify({ ...paymentRequestFixture(), reference: null }),
    );

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('corrupt-reference') === 'failed',
      'the unusable reference was closed on the FIRST tick',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(refScanCalls).toBe(0);
    expect(skill.execute).not.toHaveBeenCalled();
  });

  it('claims the signature it ASKED about, not one the strategy echoes back', async () => {
    // The settlement is the transaction the scan verified, full stop. A strategy
    // that returns some other signature (a bug, or a hostile implementation)
    // must not be able to redirect the de-duplication claim onto it.
    refScanEntries = [{ signature: REF_SCAN_CANDIDATE }];
    refPathVerify = () => ({ verified: true, txSignature: SHARED_SIGNATURE });
    recordCrashedPaidJob(ledger, 'echoed-signature');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('echoed-signature') === 'delivered',
      'the job delivered on the candidate it actually verified',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.paymentSignatureOwner(REF_SCAN_CANDIDATE)).toBe('echoed-signature');
    expect(rebootLedger.paymentSignatureOwner(SHARED_SIGNATURE)).toBeUndefined();
  });

  it('an unreachable RPC during candidate verification leaves the job recoverable', async () => {
    // THE SHAPE THE REAL SDK PRODUCES. `verifyPayment` never rejects: an
    // exhausted retry budget comes back as a RESOLVED
    // `{verified: false, error: 'Verification failed after N retries: ...'}`,
    // indistinguishable from "this is not a payment". A fixture that rejected
    // instead exercised the outer catch and left this path - the one that
    // decides whether an outage can look like non-payment - untested.
    refPathVerify = () => ({
      verified: false,
      error: `Verification failed after ${REFERENCE_SCAN_VERIFY_RETRIES} retries: 503 Service Unavailable`,
    });
    recordCrashedPaidJob(ledger, 'recover-rpc-down');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery ran its reference scan');
    await drainRecovery(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).not.toHaveBeenCalled();
    expect(rebootLedger.getStatus('recover-rpc-down')).toBe('paid');
    expect(retryCount(rebootLedger, 'recover-rpc-down')).toBe(0);
  });

  it('a throttled RPC never closes a job whose genuine payment is sitting there', async () => {
    // The whole point, end to end. The customer's real transfer is on the
    // reference; the RPC answers the LISTING but throttles every transaction
    // FETCH, so the SDK returns its resolved "Verification failed after N
    // retries" for each candidate. Two consecutive ticks of that must not add
    // up to a verdict: the money is the customer's and the job is not theirs to
    // lose over our RPC quota. Once the throttling stops, the same payment
    // verifies and the job is delivered.
    refScanEntries = [{ signature: GENUINE_SIGNATURE }];
    let throttled = true;
    refPathVerify = (candidateSignature?: string) =>
      throttled
        ? {
            verified: false,
            error: `Verification failed after ${REFERENCE_SCAN_VERIFY_RETRIES} retries: 429 Too Many Requests`,
          }
        : { verified: true, txSignature: candidateSignature };
    recordCrashedPaidJob(ledger, 'throttled-but-paid');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // 999s interval, driven tick by tick, so the sequence is exact.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'tick 1: the throttled scan ran');
    await drainRecovery(runtime);
    expect(rebootLedger.getStatus('throttled-but-paid')).toBe('paid');

    await runRecoveryTick(runtime);
    // Not terminal, and not even a step towards terminal.
    expect(rebootLedger.getStatus('throttled-but-paid')).toBe('paid');
    expect(runtime.recoveryDeferrals.sawNoPayment('throttled-but-paid')).toBe(false);

    await runRecoveryTick(runtime);
    expect(rebootLedger.getStatus('throttled-but-paid')).toBe('paid');
    expect(skill.execute).not.toHaveBeenCalled();
    expect(errorMessages(transport, 'throttled-but-paid')).toEqual([]);

    // The quota resets and the customer's payment is found, unharmed.
    throttled = false;
    await runRecoveryTick(runtime);
    await waitFor(
      () => rebootLedger.getStatus('throttled-but-paid') === 'delivered',
      'the genuine payment was found once the RPC answered',
      NEXT_TICK_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(rebootLedger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('throttled-but-paid');
  }, 30_000);

  it('an RPC error while LISTING the reference is never "unpaid"', async () => {
    // A scan that could not run is not an empty scan. Only a listing that
    // succeeded and returned nothing may end a job.
    refScanFailure = new Error('503 Service Unavailable');
    recordCrashedPaidJob(ledger, 'listing-failed');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    // DRAINED, not sampled: the listing has a retry budget, so stopping after
    // the first attempt would leave its retries running into the next test.
    await drainRecovery(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).not.toHaveBeenCalled();
    expect(rebootLedger.getStatus('listing-failed')).toBe('paid');
    expect(retryCount(rebootLedger, 'listing-failed')).toBe(0);
  });

  it('a graceful shutdown mid-verification leaves the job recoverable', async () => {
    // `stop()` aborts the in-flight recovery verification. An abort says nothing
    // about the customer, so it must never fail a job whose money may have moved.
    //
    // The verification here NEVER settles. Without the abort race inside
    // `reVerifyPayment`, the await would simply hang: the entry would still read
    // `paid` with no retries burned, so the status assertions alone cannot tell
    // "aborted cleanly" from "wedged forever". The deferral record and the log
    // line are the proof that it actually RETURNED.
    refPathVerify = () => new Promise(() => {});
    recordCrashedPaidJob(ledger, 'recover-aborted');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);
    const deferrals = runtime.recoveryDeferrals;

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery reached its reference scan');
    runtime.stop();
    await runPromise.catch(() => {});

    await waitFor(
      () => deferrals.peek('recover-aborted') !== undefined,
      'the aborted verification returned and deferred the entry',
    );
    expect(logged(/re-verification error: The operation was aborted/)).toBe(true);
    expect(skill.execute).not.toHaveBeenCalled();
    expect(rebootLedger.getStatus('recover-aborted')).toBe('paid');
    expect(retryCount(rebootLedger, 'recover-aborted')).toBe(0);
  });

  it('an abort that arrives DURING a never-settling verification still returns', async () => {
    // The other half of the race: here the signal is not yet aborted when the
    // verification starts, so a pre-check alone would not help - only the live
    // `Promise.race` against the abort event can end this.
    refPathVerify = () => new Promise(() => {});
    recordCrashedPaidJob(ledger, 'aborted-mid-flight');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);
    const deferrals = runtime.recoveryDeferrals;

    const runPromise = runtime.run();
    // Let the verification be well under way before the signal fires.
    await waitFor(() => verifyCalls.length > 0, 'the candidate verification started');
    await tick(50);
    expect(deferrals.peek('aborted-mid-flight') !== undefined).toBe(false);

    runtime.stop();
    await runPromise.catch(() => {});
    await waitFor(
      () => deferrals.peek('aborted-mid-flight') !== undefined,
      'the mid-flight abort unblocked the verification',
    );
    expect(rebootLedger.getStatus('aborted-mid-flight')).toBe('paid');
  });

  it('an abort that landed BEFORE the verification started still returns', async () => {
    // The third shape of the abort race, and the one an event listener alone
    // cannot catch: by the time the scan reaches its first candidate the signal
    // is ALREADY aborted, so no further `abort` event will ever fire. Without
    // the pre-check, the race waits on a listener that can no longer be called
    // and a never-settling verification wedges the slot for good.
    refScanListDelayMs = 300; // the listing is still running when stop() lands
    refScanEntries = [{ signature: REF_SCAN_CANDIDATE }];
    refPathVerify = () => new Promise(() => {});
    recordCrashedPaidJob(ledger, 'aborted-before-verify');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);
    const deferrals = runtime.recoveryDeferrals;

    const runPromise = runtime.run();
    // The listing has begun but has not returned, so no candidate has been
    // verified yet - the abort lands in that gap.
    await waitFor(() => refScanCalls > 0, 'the reference listing started');
    runtime.stop();
    await runPromise.catch(() => {});

    await waitFor(
      () => deferrals.peek('aborted-before-verify') !== undefined,
      'the already-aborted signal unblocked the verification',
      NEXT_TICK_MS,
    );
    expect(rebootLedger.getStatus('aborted-before-verify')).toBe('paid');
    expect(skill.execute).not.toHaveBeenCalled();
  });

  it('completes a slow scan that still FITS inside the wall-clock deadline', async () => {
    // The companion to the deadline test above, and the one that makes the
    // deadline load-bearing: every step here takes real milliseconds, so a
    // deadline of zero (or any deadline shorter than the work) abandons the scan
    // at the first candidate and the genuine payment - last in the window - is
    // never reached.
    refScanListDelayMs = 15;
    refScanEntries = [
      { signature: 'slow-junk-1' },
      { signature: 'slow-junk-2' },
      { signature: GENUINE_SIGNATURE },
    ];
    refPathVerify = async (candidateSignature?: string) => {
      await tick(15);
      return candidateSignature === GENUINE_SIGNATURE
        ? { verified: true, txSignature: GENUINE_SIGNATURE }
        : { verified: false, error: 'Recipient balance did not increase' };
    };
    recordCrashedPaidJob(ledger, 'slow-but-inside');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('slow-but-inside') === 'delivered',
      'the slow scan finished inside its budget and found the payment',
      NEXT_TICK_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(REFERENCE_SCAN_DEADLINE_MS).toBeGreaterThan(1_000);
    expect(rebootLedger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('slow-but-inside');
  });

  it('retries a failing LISTING instead of deciding a job on one RPC call', async () => {
    // The terminal verdict rests entirely on this call, against an index the
    // public RPC is known to throttle and lag. One shot deciding whether a
    // customer keeps their money is not a trade worth making: un-retried, the
    // payment below is invisible for a whole backoff rung.
    refScanEntries = [{ signature: GENUINE_SIGNATURE }];
    // A LITERAL one failure, not `ATTEMPTS - 1`: an expectation derived from the
    // constant moves with it, so a budget cut back to a single shot would pass.
    refScanTransientFailures = 1;
    recordCrashedPaidJob(ledger, 'flaky-listing');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // 999s interval: the payment must be found on the STARTUP tick, so only the
    // listing retry can explain it.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('flaky-listing') === 'delivered',
      'the retried listing found the payment on the SAME tick',
      NEXT_TICK_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(refScanCalls).toBe(2);
    expect(rebootLedger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('flaky-listing');
  });

  it('gives up on a listing that keeps failing, and never calls that "unpaid"', async () => {
    // The retry budget is bounded. Past it the scan is INCONCLUSIVE - an RPC we
    // could not reach is not an empty reference.
    refScanFailure = new Error('503 Service Unavailable');
    recordCrashedPaidJob(ledger, 'listing-always-down');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await drainRecovery(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(REFERENCE_SCAN_LIST_ATTEMPTS).toBeGreaterThan(1);
    expect(refScanCalls).toBe(REFERENCE_SCAN_LIST_ATTEMPTS);
    expect(rebootLedger.getStatus('listing-always-down')).toBe('paid');
    expect(logged(/could not reach the chain to list the reference/)).toBe(true);

    // The retries must be SPACED. Hammering a throttling RPC three times in the
    // same millisecond is not a retry budget, it is three copies of one failure:
    // the endpoint that just rate-limited us needs a moment to stop doing so.
    const gaps = refScanTimestamps
      .slice(1)
      .map((at, index) => at - (refScanTimestamps[index] as number));
    expect(gaps).toHaveLength(REFERENCE_SCAN_LIST_ATTEMPTS - 1);
    // LITERAL floors, not ones derived from the constant under test: an
    // expectation that scales with the value it checks cannot catch that value
    // going to zero. Generous, because timers fire late and never early.
    expect(REFERENCE_SCAN_LIST_RETRY_DELAY_MS).toBeGreaterThanOrEqual(100);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(100);
    }
  });

  it('stops retrying the listing once the scan deadline has passed', async () => {
    // The retry budget is bounded by the deadline too. Past it the scan is going
    // to return inconclusive whatever the listing eventually says, so spending
    // the remaining attempts only holds a `p-limit` slot shared with live intake
    // against an endpoint that is already rate-limiting us.
    refScanFailure = new Error('429 Too Many Requests');
    const realNow = Date.now;
    let clockSkewMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockSkewMs);
    refScanOnAttempt = () => {
      clockSkewMs += REFERENCE_SCAN_DEADLINE_MS + 1_000;
    };
    recordCrashedPaidJob(ledger, 'listing-past-deadline');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    // Polled with real `setTimeout`, not `waitFor`: `Date.now` is skewed inside
    // this test, which is exactly what a wall-clock poll cannot survive.
    await tick(300);
    runtime.stop();
    await runPromise.catch(() => {});
    nowSpy.mockRestore();

    // One attempt, not the full budget - and still never read as "unpaid".
    expect(REFERENCE_SCAN_LIST_ATTEMPTS).toBeGreaterThan(1);
    expect(refScanCalls).toBe(1);
    expect(rebootLedger.getStatus('listing-past-deadline')).toBe('paid');
    expect(logged(/could not reach the chain to list the reference/)).toBe(true);
  });

  it('a transient ledger-write failure keeps the job recoverable and runs it on a later tick', async () => {
    // A disk problem on OUR side must never fail a job the customer paid for.
    recordCrashedPaidJob(ledger, 'flush-fail');

    const rebootLedger = new JobLedger(ledgerPath);
    const realFlush = rebootLedger.flush.bind(rebootLedger);
    let diskIsFull = true;
    const flushSpy = vi.spyOn(rebootLedger, 'flush').mockImplementation(() => {
      const entry = rebootLedger
        .allEntries()
        .find((candidate) => candidate.job_id === 'flush-fail');
      if (diskIsFull && entry?.payment_signature !== undefined) {
        throw new Error('ENOSPC: no space left on device');
      }
      realFlush();
    });

    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // A real recovery interval, so the retry is a later TICK of one process.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 1 });
    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery ran its reference scan');

    // First tick: refused fail-closed, but the entry stays recoverable.
    expect(skill.execute).not.toHaveBeenCalled();
    expect(rebootLedger.getStatus('flush-fail')).toBe('paid');

    diskIsFull = false;
    await waitFor(
      () => rebootLedger.getStatus('flush-fail') === 'delivered',
      'the job delivered once the disk was writable again',
      BACKOFF_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});
    flushSpy.mockRestore();

    expect(skill.execute).toHaveBeenCalledOnce();
    expect(rebootLedger.paymentSignatureOwner(REF_SCAN_CANDIDATE)).toBe('flush-fail');
  });
});

describe('the endpoint has to earn the right to end a paying customer`s job', () => {
  /**
   * Drive an entry whose reference is empty through enough ticks to reach the
   * two-consecutive-scans verdict, and report whether it landed.
   */
  async function driveEmptyScansToVerdict(jobId: string): Promise<{
    ledger: JobLedger;
    transport: NostrTransport;
  }> {
    refScanEntries = [];
    recordCrashedPaidJob(ledger, jobId);

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the first empty scan ran');
    await drainRecovery(runtime);
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});
    return { ledger: rebootLedger, transport };
  }

  it('refuses the terminal verdict when the endpoint is on the WRONG CLUSTER', async () => {
    // `SOLANA_RPC_URL` is an unvalidated environment variable, and both empty
    // listings come from the SAME client. An agent configured for devnet but
    // pointed at mainnet sees every devnet reference as empty - and would tell
    // every paying customer their money bought nothing.
    genesisHash = CLUSTER_GENESIS_HASHES.mainnet;

    const { ledger: rebootLedger, transport } = await driveEmptyScansToVerdict('wrong-cluster');

    expect(rebootLedger.getStatus('wrong-cluster')).toBe('paid');
    expect(errorMessages(transport, 'wrong-cluster')).toEqual([]);
    // Loud, and exactly once however many entries hit it - an operator has to be
    // able to see WHY jobs stopped closing.
    const shouts = logs.filter((line) =>
      /cannot be trusted to decide that a customer did not pay/.test(line),
    );
    expect(shouts).toHaveLength(1);
    expect(shouts[0]).toMatch(/reports genesis/);
  }, 30_000);

  it('refuses the terminal verdict when the endpoint does not serve address history', async () => {
    // A node started without transaction history answers the genesis check
    // happily and errors on every `getSignaturesForAddress`. That is a provider
    // misconfiguration, not a customer who failed to pay.
    historyProbeFailure = new Error('Transaction history is not available from this node');

    const { ledger: rebootLedger, transport } = await driveEmptyScansToVerdict('no-history');

    expect(rebootLedger.getStatus('no-history')).toBe('paid');
    expect(errorMessages(transport, 'no-history')).toEqual([]);
    expect(listedAddresses).toContain(ADDRESS_HISTORY_PROBE_ADDRESS);
    expect(logged(/did not answer an address-history query/)).toBe(true);
  }, 30_000);

  it('refuses the terminal verdict when the endpoint will not say which chain it is', async () => {
    // Unlike a wrong cluster, this one is not cached as hopeless: an endpoint
    // that is merely down must be re-asked, not condemned for the life of the
    // process. So it is probed again on every attempt and still never concludes.
    genesisFailure = new Error('503 Service Unavailable');

    const { ledger: rebootLedger } = await driveEmptyScansToVerdict('genesis-down');

    expect(rebootLedger.getStatus('genesis-down')).toBe('paid');
    expect(genesisCalls).toBeGreaterThan(1);
    expect(logged(/did not answer getGenesisHash/)).toBe(true);
    // ...and shouted about exactly ONCE, even though it was re-probed every
    // attempt. This is the one condition that is not cached, so an un-deduped
    // warning is a line per entry per tick - roughly 1440 a day per stuck job,
    // which buries every other message an operator needs.
    expect(logs.filter((line) => /did not answer getGenesisHash/.test(line))).toHaveLength(1);
  }, 30_000);

  it('re-probes an endpoint that failed INSTANTLY, instead of pinning that answer', async () => {
    // The probe is single-flight: one check in flight, shared by every entry
    // that needs it, and the slot is released when it settles. A client that
    // fails without ever awaiting - an unusable URL, a transport rejected on
    // construction - settles the WHOLE check synchronously, before the slot it
    // is supposed to occupy has even been filled. Release it from inside the
    // check and that write lands first, leaving the resolved "no" parked in the
    // slot for the life of the process: `endpointSoundness` stays unchecked,
    // every later entry reads the stale answer, and this agent can never close
    // an unpaid job again - including on an endpoint that has since recovered.
    genesisThrowsSynchronously = true;
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'instant-fail-a');
    recordCrashedPaidJob(ledger, 'instant-fail-b');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the first empty scan ran');
    await drainRecovery(runtime);
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);

    // Nothing closes while the endpoint cannot prove itself - the safe direction.
    expect(rebootLedger.getStatus('instant-fail-a')).toBe('paid');
    // It never reached `send`, so the unreachable branch is the one under test.
    expect(genesisCalls).toBe(0);

    // The endpoint comes back. The SAME process has to be able to believe it.
    genesisThrowsSynchronously = false;
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(genesisCalls).toBeGreaterThan(0);
    expect(rebootLedger.getStatus('instant-fail-a')).toBe('failed');
    expect(rebootLedger.getStatus('instant-fail-b')).toBe('failed');
  }, 30_000);

  it('a healthy endpoint still closes the job, and proves itself exactly once', async () => {
    // The companion that keeps the three tests above honest: with the endpoint
    // sound the verdict lands as before. And the proof is CACHED - a check
    // re-run per scan would add two RPC calls to every deferred entry, every
    // tick, on the slot paying customers share.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'sound-endpoint-a');
    recordCrashedPaidJob(ledger, 'sound-endpoint-b');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 1 });

    const runPromise = runtime.run();
    await waitFor(
      () =>
        rebootLedger.getStatus('sound-endpoint-a') === 'failed' &&
        rebootLedger.getStatus('sound-endpoint-b') === 'failed',
      'both unpaid jobs were closed',
      BACKOFF_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(genesisCalls).toBe(1);
    expect(listedAddresses.filter((queried) => queried === ADDRESS_HISTORY_PROBE_ADDRESS)).toEqual([
      ADDRESS_HISTORY_PROBE_ADDRESS,
    ]);
    expect(logged(/cannot be trusted to decide that a customer did not pay/)).toBe(false);
  }, 30_000);
});

describe('every terminal recovery verdict tells the customer', () => {
  it('closes a job whose tags no longer route to any skill - and says so', async () => {
    // A skill renamed, re-priced or removed between accepting the job and
    // recovering it. Terminal (no amount of waiting brings a skill back) and
    // reachable for a customer who already paid, so a silent `markFailed` leaves
    // them watching a job that will never answer.
    recordCrashedPaidJob(ledger, 'orphaned-tags');

    const rebootLedger = new JobLedger(ledgerPath);
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(null, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('orphaned-tags') === 'failed',
      'the un-routable job was closed',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    const notice = errorMessages(transport, 'orphaned-tags');
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatch(/no longer offers a skill for this job/);
    // It must not accuse the customer of anything - nobody here knows whether
    // they paid.
    expect(notice[0]).not.toMatch(/no payment/i);
  });

  it('closes a paid entry with NO persisted payment request - and says so', async () => {
    // The fifth terminal recovery verdict, and the only one whose cause is
    // entirely ours: the entry says a payment was required but carries nothing
    // to verify it against. Waiting cannot conjure a payment request, so it is
    // closed now rather than held for 24h - and the customer is told, in the
    // wording that never asserts they failed to pay, because nobody here knows
    // that. `collectPayment` persists the request before it verifies, so this is
    // a hand-edited or half-written ledger; the notice is what makes it visible
    // instead of a job that silently disappears.
    ledger.recordPaid({
      job_id: 'no-request',
      input: 'test input',
      input_type: 'text',
      tags: ['elisym', 'text-gen'],
      customer_id: 'customer',
      raw_event_json: JSON.stringify(makeJob('no-request').rawEvent),
      created_at: Math.floor(Date.now() / 1000),
    });

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('no-request') === 'failed',
      'the entry with no payment request was closed',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).not.toHaveBeenCalled();
    // No reference to scan, so no RPC was spent on it either.
    expect(refScanCalls).toBe(0);
    const notice = errorMessages(transport, 'no-request');
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatch(/could not verify payment for this job/);
    expect(notice[0]).not.toMatch(/did not pay/);
  });

  it('closes a job whose input file cannot be recovered - and says so', async () => {
    // The input cannot be re-fetched, and re-executing without it would produce
    // the wrong answer for work the customer already paid for. Terminal either
    // way; the customer has to hear it.
    refScanEntries = [{ signature: GENUINE_SIGNATURE }];
    const rawEvent = makeJob('lost-input').rawEvent as Record<string, unknown>;
    recordCrashedPaidJob(ledger, 'lost-input', {
      rawEvent: {
        ...rawEvent,
        // A well-formed elisym envelope that fails its own schema: the recovery
        // decode throws, which is the same branch a blob that cannot be fetched
        // reaches.
        tags: [
          ['i', JSON.stringify({ v: 'elisym-job/1', text: 42 }), 'text'],
          ['t', 'elisym'],
          ['t', 'text-gen'],
        ],
      },
    });

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('lost-input') === 'failed',
      'the job with an unrecoverable input was closed',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).not.toHaveBeenCalled();
    expect(logged(/input file unavailable/)).toBe(true);
    const notice = errorMessages(transport, 'lost-input');
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatch(/input file for this job could not be retrieved/);
  });
});

describe('the delegated discriminator', () => {
  it('routes on the LEDGER FLAG even when the raw event does not carry the tag', async () => {
    // The flag is the primary discriminator and the persisted event's tag is the
    // fallback, not the other way round. A hand-repaired entry (or any future
    // path that marks an entry delegated without re-writing its event) must
    // still reconcile through the pull path - routing it to `reVerifyPayment`
    // would scan a reference a delegated job never had.
    recordCrashedPaidJob(ledger, 'flag-only-delegated');
    ledger.markDelegated('flag-only-delegated');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('flag-only-delegated') === 'failed',
      'the flagged entry reconciled through the delegated path',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(logged(/delegated entry has no pull/)).toBe(true);
    // Never touched the flat paid rail.
    expect(refScanCalls).toBe(0);
    expect(skill.execute).not.toHaveBeenCalled();
  });

  it('parses the persisted event ONCE per entry, not once per tick', () => {
    // The scan-budget gate asks this of every non-deferred pending entry on
    // every tick, and an over-budget entry is parked and asked again next tick.
    // Uncached, a backlog re-parses every customer's whole payload (up to the
    // 64KB inline cap) once a minute to read one tag.
    const rawEventJson = JSON.stringify(makeJob('memo-probe').rawEvent);
    let reads = 0;
    const entry = {
      get raw_event_json(): string {
        reads += 1;
        return rawEventJson;
      },
    };
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(makePaidSkill(), transport);
    const internals = runtime as unknown as {
      isDelegatedEntry: (candidate: object) => boolean;
    };

    expect(internals.isDelegatedEntry(entry)).toBe(false);
    expect(internals.isDelegatedEntry(entry)).toBe(false);
    expect(internals.isDelegatedEntry(entry)).toBe(false);
    expect(reads).toBe(1);
  });
});

describe('the recovery retry budget is real', () => {
  it('a recovery re-execution burns exactly one retry', async () => {
    // The bound below is only a bound if the counter actually moves. Every other
    // retry assertion in this suite pins it at ZERO (the retry-free skips), so
    // without this one, deleting the increment outright changes nothing.
    refScanEntries = [{ signature: GENUINE_SIGNATURE }];
    recordCrashedPaidJob(ledger, 'one-retry');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('one-retry') === 'delivered',
      'the recovered job was delivered',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(retryCount(rebootLedger, 'one-retry')).toBe(1);
  });

  it('closes a job whose re-execution keeps failing, at the configured bound', async () => {
    // The 24h cutoff is not the only backstop: an entry that re-executes and
    // fails every tick would otherwise hold a slot for a day. Without the
    // increment on the re-execute path the bound can never be reached at all.
    refScanEntries = [{ signature: GENUINE_SIGNATURE }];
    recordCrashedPaidJob(ledger, 'always-fails');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    skill.execute = vi.fn().mockRejectedValue(new Error('the skill is broken'));
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, {
      recoveryIntervalSecs: 999,
      recoveryMaxRetries: 2,
    });

    const runPromise = runtime.run();
    await drainRecovery(runtime);
    // Tick 1 executed and failed; tick 2 does the same; tick 3 finds the budget
    // spent and closes the entry.
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(retryCount(rebootLedger, 'always-fails')).toBeGreaterThanOrEqual(2);
    expect(rebootLedger.getStatus('always-fails')).toBe('failed');
    expect(errorMessages(transport, 'always-fails')).toContain(
      'Job permanently failed after maximum retries',
    );
  }, 30_000);
});

describe('a deferred entry is bounded in cost', () => {
  /**
   * An entry that can never CONCLUDE: the only transaction on its reference was
   * already settled by another job, so every scan skips it and stays
   * inconclusive - which is what these tests need to observe, a backlog that
   * neither closes nor confirms.
   */
  function seedPermanentlyDeferredJob(jobId: string): void {
    seedConsumedSettlement(ledger, `stranger-for-${jobId}`, SHARED_SIGNATURE);
    refScanEntries = [{ signature: SHARED_SIGNATURE }];
    recordCrashedPaidJob(ledger, jobId);
  }

  it('the backoff ladder ESCALATES - it is not a flat one-tick wait', () => {
    // A flat ladder is indistinguishable from "retry every tick" once the first
    // rung has elapsed, which is the whole cost this ladder exists to bound.
    expect(RECOVERY_DEFER_BACKOFF_TICKS[0]).toBe(1);
    for (let rung = 1; rung < RECOVERY_DEFER_BACKOFF_TICKS.length; rung++) {
      expect(RECOVERY_DEFER_BACKOFF_TICKS[rung]).toBeGreaterThan(
        RECOVERY_DEFER_BACKOFF_TICKS[rung - 1] as number,
      );
    }
  });

  it('CLAMPS to the last rung instead of falling off the end of the ladder', () => {
    // Past the last rung the index is out of range. Unclamped it reads
    // `undefined` and falls back to ONE tick, so an entry that has been deferred
    // forever - exactly the case the ladder exists for - would go back to
    // re-scanning every single tick for the remaining 23 hours.
    const intervalSecs = 60;
    const lastRung = RECOVERY_DEFER_BACKOFF_TICKS[
      RECOVERY_DEFER_BACKOFF_TICKS.length - 1
    ] as number;

    for (const attempts of [RECOVERY_DEFER_BACKOFF_TICKS.length, 7, 50, 5_000]) {
      // Jitter 0: the rung itself, with no spread to hide behind.
      expect(recoveryDeferDelayMs(attempts, intervalSecs, 0)).toBe(lastRung * intervalSecs * 1000);
    }
  });

  it('CLIMBS the ladder on each consecutive inconclusive tick', () => {
    // The ladder only bounds anything if the attempt count actually advances.
    // A `note` that always records the first rung is a flat one-tick wait
    // wearing a ladder's clothes - the entry comes back every tick or two for
    // the whole 24h, which is the cost this exists to stop. Asserted directly
    // rather than through the recovery loop: at the 1s interval the tests use,
    // rung 1 and a never-advancing ladder are only a scan or two apart.
    const intervalSecs = 60;
    // `random()` of 0.5 maps to a jitter of 0 (`random * 2 - 1`), so the rung
    // itself is what is under test, with no spread to hide behind.
    const deferrals = new RecoveryDeferrals(
      () => intervalSecs,
      () => 0.5,
    );
    const startedAt = Date.now();

    deferrals.note('climber');
    const firstWait = (deferrals.peek('climber')?.nextAttemptAt ?? 0) - startedAt;
    const firstDeferredAt = deferrals.peek('climber')?.firstDeferredAt;
    deferrals.note('climber');
    const secondWait = (deferrals.peek('climber')?.nextAttemptAt ?? 0) - startedAt;

    expect(deferrals.peek('climber')?.attempts).toBe(2);
    expect(secondWait).toBeGreaterThan(firstWait);
    // The clock the operator summary reports from is the FIRST deferral, not
    // the latest one, or "oldest deferred" would reset on every attempt.
    expect(deferrals.peek('climber')?.firstDeferredAt).toBe(firstDeferredAt);

    // ...all the way to the top rung, where it stays.
    const lastRung = RECOVERY_DEFER_BACKOFF_TICKS[
      RECOVERY_DEFER_BACKOFF_TICKS.length - 1
    ] as number;
    for (let attempt = 2; attempt < RECOVERY_DEFER_BACKOFF_TICKS.length; attempt++) {
      deferrals.note('climber');
    }
    expect(deferrals.peek('climber')?.attempts).toBe(RECOVERY_DEFER_BACKOFF_TICKS.length);
    expect((deferrals.peek('climber')?.nextAttemptAt ?? 0) - Date.now()).toBeGreaterThan(
      ((lastRung - 1) * intervalSecs * 1000) / 1,
    );
  });

  it('ages the backlog from the FIRST deferral, not the latest one', () => {
    // `firstDeferredAt` is the only thing behind "oldest deferred" in the
    // once-per-tick backlog summary, which is how an operator sees that entries
    // are piling up rather than moving. Re-stamp it on every attempt and that
    // number reports the age of the last look instead: it sits near zero forever
    // no matter how long an entry has been stuck, which is the one thing the line
    // exists to show. Needs a MOVING clock - two attempts in the same
    // millisecond are indistinguishable, which is exactly how this got past a
    // test that asserted it without one.
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const deferrals = new RecoveryDeferrals(
        () => 60,
        () => 0.5,
      );
      const firstLook = 1_700_000_000_000;
      nowSpy.mockReturnValue(firstLook);
      deferrals.note('ageing');
      // Every way an entry can be held back must preserve it, not just `note`.
      nowSpy.mockReturnValue(firstLook + 5 * 60_000);
      deferrals.note('ageing');
      nowSpy.mockReturnValue(firstLook + 20 * 60_000);
      deferrals.parkForCapacity('ageing');
      nowSpy.mockReturnValue(firstLook + 90 * 60_000);
      deferrals.noteAwaitingWindow('ageing');

      expect(deferrals.peek('ageing')?.firstDeferredAt).toBe(firstLook);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does NOT climb the ladder while the customer`s own window is still open', () => {
    // The ladder counts inconclusive LOOKS - the chain, the RPC or our own disk
    // letting us down. "Nobody has paid yet, four minutes into a ten-minute
    // window" is none of those; it is the ordinary state of a fresh job. Count it
    // and the rung is already at 5 or 15 ticks by the time the customer actually
    // pays, so a wallet that confirms late in its window is not looked at again
    // for several minutes - and a job nobody ever pays reaches its expiry parked
    // on a half-hour rung, holding a `paid` entry and its recovery slot for the
    // better part of an hour before the two scans that close it can even run.
    const intervalSecs = 60;
    const deferrals = new RecoveryDeferrals(
      () => intervalSecs,
      () => 0.5,
    );
    const startedAt = Date.now();

    for (let look = 0; look < 5; look++) {
      deferrals.noteAwaitingWindow('in-window');
    }
    expect(deferrals.peek('in-window')?.attempts).toBe(0);
    // ...so the wait stays at the bottom rung however long the window runs.
    expect((deferrals.peek('in-window')?.nextAttemptAt ?? 0) - startedAt).toBeLessThanOrEqual(
      (RECOVERY_DEFER_BACKOFF_TICKS[0] as number) * intervalSecs * 1000 * 1.5,
    );

    // And an in-window look never counts toward the two consecutive sightings
    // that close a job: it was taken before the customer's deadline.
    deferrals.note('banked', true);
    expect(deferrals.sawNoPayment('banked')).toBe(true);
    deferrals.noteAwaitingWindow('banked');
    expect(deferrals.sawNoPayment('banked')).toBe(false);

    // The ladder still climbs normally once the window is behind us.
    deferrals.note('in-window');
    expect(deferrals.peek('in-window')?.attempts).toBe(1);
  });

  it('SEPARATES the two looks that can close a paid job, even from rung one', () => {
    // "Two consecutive empty scans" is only worth a customer's money if the two
    // are independent, and the reason a second is demanded at all is that the
    // public RPC lags this index: a transaction confirmed in the last seconds of
    // the window can be absent from two listings a minute apart and present on
    // the third. The ladder used to supply that spacing by accident - in-window
    // scans climbed it before the deadline passed - so when they stopped doing
    // that, the first post-expiry sighting would have banked at rung 1 and the
    // job would have closed ~60s later on a fresh, laggy reference.
    //
    // The clock is FROZEN for the assertions below. They compare an exact number
    // of milliseconds against a separately sampled `Date.now()`, and a real clock
    // that ticks once between the two samples makes that off by one - which is
    // exactly how this test failed in CI (expected 300000, received 300001).
    // Freezing keeps the assertion exact, which is what gives it teeth, without
    // making it a coin flip.
    const intervalSecs = 60;
    const nowSpy = vi.spyOn(Date, 'now');
    const startedAt = 1_700_000_000_000;
    nowSpy.mockReturnValue(startedAt);
    const deferrals = new RecoveryDeferrals(
      () => intervalSecs,
      () => 0.5, // jitter 0: the rung itself, with no spread to hide behind
    );

    try {
      deferrals.note('closing-in', true);

      expect(deferrals.sawNoPayment('closing-in')).toBe(true);
      // Pinned as a LITERAL, not through the constant: every other assertion here
      // reads `TERMINAL_CONFIRMATION_MIN_RUNG`, so lowering it moves both sides of
      // those comparisons together and they keep passing with no floor at all.
      // Five ticks is the guarantee - five minutes at the default cadence, which
      // is the spacing this exists to buy.
      expect(
        RECOVERY_DEFER_BACKOFF_TICKS[TERMINAL_CONFIRMATION_MIN_RUNG - 1] as number,
      ).toBeGreaterThanOrEqual(5);
      // The count still advances - only the wait is floored.
      expect(deferrals.peek('closing-in')?.attempts).toBe(1);
      expect((deferrals.peek('closing-in')?.nextAttemptAt ?? 0) - startedAt).toBe(
        (RECOVERY_DEFER_BACKOFF_TICKS[TERMINAL_CONFIRMATION_MIN_RUNG - 1] as number) *
          intervalSecs *
          1000,
      );

      // An ordinary inconclusive look is NOT floored: it cannot close anything, so
      // making it wait would only slow down a job whose payment is still findable.
      deferrals.note('ordinary');
      expect((deferrals.peek('ordinary')?.nextAttemptAt ?? 0) - startedAt).toBe(
        (RECOVERY_DEFER_BACKOFF_TICKS[0] as number) * intervalSecs * 1000,
      );

      // And past the floor the ladder keeps climbing on its own terms.
      for (let look = 0; look < RECOVERY_DEFER_BACKOFF_TICKS.length; look++) {
        deferrals.note('closing-in', true);
      }
      const lastRung = RECOVERY_DEFER_BACKOFF_TICKS[
        RECOVERY_DEFER_BACKOFF_TICKS.length - 1
      ] as number;
      expect((deferrals.peek('closing-in')?.nextAttemptAt ?? 0) - startedAt).toBe(
        lastRung * intervalSecs * 1000,
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('JITTERS each rung so entries deferred together do not come back together', () => {
    // Without jitter every entry deferred on the same tick becomes due on the
    // same later tick, forever - the herd this is here to break up.
    const intervalSecs = 60;
    const intervalMs = intervalSecs * 1000;
    const earliest = recoveryDeferDelayMs(1, intervalSecs, -1);
    const latest = recoveryDeferDelayMs(1, intervalSecs, 1);

    expect(latest).toBeGreaterThan(earliest);
    // Rung 1 lands on the next tick or the one after, never sooner and never
    // later - that is what the documented ladder means.
    expect(earliest).toBeGreaterThanOrEqual(intervalMs / 2);
    expect(latest).toBeLessThanOrEqual(intervalMs * 1.5);
  });

  it('confirms a payment even while the skill`s own LLM is down', async () => {
    // Ordering, and it is a money question rather than a tidiness one. The tick
    // charges this entry one of its five reference scans BEFORE the job reaches
    // the LLM-health gate. Gate first and the scan never happens - yet the
    // budget is spent, and the entry, having neither scanned nor deferred, is
    // first in line again on the very next tick. An agent with one dead API key
    // then spends its whole budget, every tick, on entries that scan nothing,
    // while the customers of its HEALTHY skills go unverified for the length of
    // the outage; any that reach the 24h cutoff are closed with the money taken.
    // Confirming a payment needs no LLM - only running the job does.
    const skill = {
      ...makePaidSkill(),
      mode: 'llm',
      resolvedTriple: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    } as unknown as Skill;
    const unhealthy = {
      assertReady: vi
        .fn()
        .mockRejectedValue(
          new LlmHealthError('billing', 'anthropic', 'claude-haiku-4-5', 'HTTP 402'),
        ),
      // The runtime reads this on startup to report the fleet's health.
      snapshot: () => [],
    };
    refScanEntries = [{ signature: GENUINE_SIGNATURE }];
    recordCrashedPaidJob(ledger, 'llm-down');

    const rebootLedger = new JobLedger(ledgerPath);
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(
      skill,
      transport,
      rebootLedger,
      { recoveryIntervalSecs: 999 },
      unhealthy,
    );

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the payment scan ran despite the unhealthy pair');
    await drainRecovery(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    // The payment is found and bound...
    expect(rebootLedger.paymentSignatureOwner(GENUINE_SIGNATURE)).toBe('llm-down');
    // ...and only the EXECUTION waits for the model to come back.
    expect(unhealthy.assertReady).toHaveBeenCalled();
    expect(skill.execute).not.toHaveBeenCalled();
    expect(rebootLedger.getStatus('llm-down')).toBe('paid');
    expect(errorMessages(transport, 'llm-down')).toEqual([]);
  }, 30_000);

  it('caps how many payment re-scans ONE tick starts', async () => {
    // A restart forgets every deferral, so without a budget the first tick
    // starts a scan for every pending entry at once - filling the p-limit and
    // queue that paying customers share, and answering them "Server overloaded".
    // The budget has to BOUND something, so pin it against the concurrency this
    // runtime is actually CONFIGURED with - not a fixed number, and not the
    // test's own expectation, either of which would let "no cap at all" pass.
    const configuredConcurrency = 6;
    const budget = recoveryScanBudgetPerTick(configuredConcurrency);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(configuredConcurrency);
    // Never zero, however small the configured concurrency: a budget of zero
    // parks every entry forever and no payment is ever confirmed.
    expect(recoveryScanBudgetPerTick(1)).toBe(1);
    const overBudget = budget + 3;
    seedConsumedSettlement(ledger, 'stranger-job', SHARED_SIGNATURE);
    refScanEntries = [{ signature: SHARED_SIGNATURE }];
    for (let index = 0; index < overBudget; index++) {
      recordCrashedPaidJob(ledger, `budget-${index}`);
    }

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // 999s interval: `run()`'s startup pass is the only tick in this test.
    const runtime = makeRuntime(skill, transport, rebootLedger, {
      recoveryIntervalSecs: 999,
      maxConcurrentJobs: configuredConcurrency,
      maxQueueSize: overBudget * 10,
    });

    const runPromise = runtime.run();
    await drainRecovery(runtime);
    await tick(50);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(refScanCalls).toBe(budget);
    // The rest are parked, not dropped - and inside a SUB-TICK window, so they
    // are due again by the next tick; the BUDGET is what spreads them across
    // ticks.
    const deferrals = runtime.recoveryDeferrals;
    expect(deferrals.size).toBe(overBudget);
    const parked = [...Array(overBudget).keys()]
      .map((index) => deferrals.peek(`budget-${index}`))
      .filter((deferral) => deferral !== undefined && deferral.attempts === 0);
    // Parking for capacity is NOT a deferral: the ladder must not advance (an
    // entry nobody looked at has no evidence against it) and the wait must stay
    // under one tick, or a busy restart pushes work minutes into the future.
    expect(parked.length).toBe(overBudget - budget);
    for (const deferral of parked) {
      expect((deferral?.nextAttemptAt ?? 0) - Date.now()).toBeLessThanOrEqual(
        runtimeIntervalMs(runtime),
      );
      expect(deferral?.sawNoPayment).toBe(false);
    }
    for (const entry of rebootLedger.allEntries()) {
      if (entry.job_id.startsWith('budget-')) {
        expect(entry.status).toBe('paid');
      }
    }
  });

  it('spends the scan budget only on entries that will actually scan', () => {
    // The budget is a scarce, shared resource: a slot spent on an entry that was
    // never going to touch the chain parks a real paid job for a whole tick. The
    // four exclusions each rule out a different non-scanner - a delegated entry
    // (reconciled through the pull path, which never reads the reference), an
    // entry whose payment is already confirmed, one with nothing persisted to
    // scan against, and one that has moved past `paid` altogether.
    const awaitingPayment = { status: 'paid', payment_request: '{\"reference\":\"ref\"}' };

    expect(needsPaymentScan(awaitingPayment, false)).toBe(true);
    expect(needsPaymentScan(awaitingPayment, true)).toBe(false);
    expect(needsPaymentScan({ ...awaitingPayment, net_amount: 97_000 }, false)).toBe(false);
    expect(needsPaymentScan({ status: 'paid' }, false)).toBe(false);
    expect(needsPaymentScan({ ...awaitingPayment, status: 'executed' }, false)).toBe(false);
  });

  it('parking for capacity never discards an empty-scan sighting', async () => {
    // The sighting is the first half of the two-consecutive-scans rule. Parking
    // an entry because the tick was busy is not a scan, so it must neither set
    // the sighting nor clear one - clearing it would make an unpaid job take
    // three passes on a busy agent and none on an idle one.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'parked-with-sighting');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });
    const deferrals = runtime.recoveryDeferrals;

    const runPromise = runtime.run();
    await waitFor(
      () => deferrals.sawNoPayment('parked-with-sighting'),
      'the first empty scan recorded its sighting',
    );
    const afterScan = deferrals.peek('parked-with-sighting');

    deferrals.parkForCapacity('parked-with-sighting');
    const afterPark = deferrals.peek('parked-with-sighting');
    expect(afterPark?.sawNoPayment).toBe(true);
    expect(afterPark?.attempts).toBe(afterScan?.attempts);

    // ...so the very next scan that runs is the SECOND consecutive one.
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});
    expect(rebootLedger.getStatus('parked-with-sighting')).toBe('failed');
  });

  it('summarises the deferral backlog once per tick', async () => {
    // A pinned entry otherwise produces the same per-entry line as a flaky RPC,
    // roughly thirty times a day, with no way to tell "one job is stuck" from
    // "the chain is unreachable".
    seedPermanentlyDeferredJob('summarised');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await drainRecovery(runtime);
    expect(logs.filter((line) => /job(s)? (is|are) deferred/.test(line))).toHaveLength(0);

    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    const summaries = logs.filter((line) => /job(s)? (is|are) deferred/.test(line));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatch(/1 job is deferred/);
    expect(summaries[0]).toMatch(/oldest deferred \d+m ago/);
  });

  it('says so, once, when the backlog finally clears', async () => {
    // A summary that simply stops appearing is indistinguishable from an agent
    // that stopped logging. An operator watching a stuck agent needs to see the
    // end of it - and needs to see it exactly once, not on every idle tick
    // afterwards.
    seedPermanentlyDeferredJob('clears');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });

    const runPromise = runtime.run();
    await drainRecovery(runtime);
    await runRecoveryTick(runtime);
    expect(logs.filter((line) => /1 job is deferred/.test(line))).toHaveLength(1);

    // The entry leaves the pending set, so the sweep empties the backlog.
    rebootLedger.markFailed('clears');
    await runRecoveryTick(runtime);
    await runRecoveryTick(runtime);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(logs.filter((line) => /no jobs are deferred/.test(line))).toHaveLength(1);
  }, 30_000);

  it('a confirmed payment drops its deferral, so the reported age cannot inflate', async () => {
    // The summary reports how long the OLDEST entry has been held back. An entry
    // that was deferred and then confirmed is not held back any more; leaving
    // its record in place would keep ageing a backlog nobody is waiting for, and
    // the one number an operator reads - how close this is to the 24h cutoff -
    // would drift further from the truth every tick.
    refScanEntries = [];
    recordCrashedPaidJob(ledger, 'deferred-then-paid');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });
    const deferrals = runtime.recoveryDeferrals;

    const runPromise = runtime.run();
    await waitFor(
      () => deferrals.peek('deferred-then-paid') !== undefined,
      'the empty scan deferred the entry',
    );

    // The customer's transfer lands between ticks.
    refScanEntries = [{ signature: GENUINE_SIGNATURE }];
    await runRecoveryTick(runtime);
    await waitFor(
      () => rebootLedger.getStatus('deferred-then-paid') === 'delivered',
      'the payment was found and the job delivered',
      NEXT_TICK_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(deferrals.peek('deferred-then-paid')).toBeUndefined();
    expect(deferrals.size).toBe(0);
  }, 30_000);

  it('does not re-scan on every tick - successive deferrals wait longer', async () => {
    // A deferred entry re-runs the whole payment check, holding a p-limit slot
    // and a queue slot shared with live intake. At one scan per tick for 24h a
    // handful of griefed entries is enough to starve paying customers.
    seedPermanentlyDeferredJob('backoff-entry');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 1 });

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'the first recovery scan ran');
    const afterFirstScan = refScanCalls;

    // Five ticks' worth of wall clock. Retrying every tick is five more scans;
    // a ladder that climbs 1 -> 2 -> 5 ticks gets two (at +1s and +3s) and is
    // then parked past the window. The gap is what makes a flat or
    // never-advancing ladder fail here rather than squeak through on jitter.
    await tick(5_200);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(refScanCalls - afterFirstScan).toBeLessThanOrEqual(3);
    expect(rebootLedger.getStatus('backoff-entry')).toBe('paid');
    expect(retryCount(rebootLedger, 'backoff-entry')).toBe(0);
  }, 10_000);

  it('sweeps the deferral state of entries that have left the pending set', async () => {
    // The backoff map is in-memory and keyed by job id. Without the sweep at the
    // top of every recovery tick it grows with the ledger for the life of the
    // process, which is the bounded-memory claim the map is sold on.
    seedPermanentlyDeferredJob('swept-entry');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 1 });
    const deferrals = runtime.recoveryDeferrals;

    const runPromise = runtime.run();
    await waitFor(() => deferrals.size === 1, 'the entry recorded a deferral');

    // It leaves the pending set (here: terminal by any route - the 24h cutoff,
    // a delivery, an operator).
    rebootLedger.markFailed('swept-entry');
    await waitFor(() => deferrals.size === 0, 'the deferral state was swept', NEXT_TICK_MS);
    runtime.stop();
    await runPromise.catch(() => {});
  });

  it('the 24h cutoff fires even while an entry is inside its deferral window', async () => {
    // ORDER: the deferral skip sits AFTER the age/retry cutoff. Reversed, a
    // permanently-deferred entry parked on a 60-tick rung would outlive the one
    // backstop that is supposed to close it, and the customer would never get
    // the failure feedback.
    seedPermanentlyDeferredJob('aged-out');
    const entry = ledger.allEntries().find((candidate) => candidate.job_id === 'aged-out');
    if (entry) {
      entry.created_at = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
      ledger.flush();
    }

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    // One startup tick only: whatever happens must happen on that tick.
    const runtime = makeRuntime(skill, transport, rebootLedger, { recoveryIntervalSecs: 999 });
    // Park it deep in a deferral window (999s) before the tick ever runs.
    runtime.recoveryDeferrals.note('aged-out');

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('aged-out') === 'failed',
      'the 24h cutoff closed the deferred entry',
    );
    // The startup tick can settle this inside `run()`'s own first await, before
    // it reaches the shutdown wait - give it a turn so `stop()` is observed.
    await tick();
    runtime.stop();
    await runPromise.catch(() => {});

    // Closed as "the agent did not recover", and the customer was told.
    expect(errorMessages(transport, 'aged-out').length).toBeGreaterThan(0);
    expect(refScanCalls).toBe(0);
  });

  it('does not run the skill preflight for an entry still awaiting payment', async () => {
    // For an x402 skill the preflight buys a LIVE upstream quote. Paying for
    // quotes on behalf of a job whose payment is not even confirmed is exactly
    // the work a deferral has to skip.
    seedPermanentlyDeferredJob('preflight-skipped');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    skill.preflight = vi.fn().mockResolvedValue(undefined);
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(() => refScanCalls > 0, 'recovery ran its reference scan');
    await tick(50);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.preflight).not.toHaveBeenCalled();
    expect(skill.execute).not.toHaveBeenCalled();
    expect(rebootLedger.getStatus('preflight-skipped')).toBe('paid');
  });

  it('DOES run the preflight once the payment is confirmed', async () => {
    // The companion assertion: the gate is skipped for lack of payment, not
    // dropped. Otherwise the test above would pass on a deleted preflight.
    recordCrashedPaidJob(ledger, 'preflight-runs');

    const rebootLedger = new JobLedger(ledgerPath);
    const skill = makePaidSkill();
    skill.preflight = vi.fn().mockResolvedValue(undefined);
    const { transport } = makeFakeTransport(always(null));
    const runtime = makeRuntime(skill, transport, rebootLedger);

    const runPromise = runtime.run();
    await waitFor(
      () => rebootLedger.getStatus('preflight-runs') === 'delivered',
      'the confirmed job ran through preflight and delivered',
    );
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.preflight).toHaveBeenCalledOnce();
  });
});

describe('the live path never issues the terminal verdict', () => {
  /** Drive one paid job through the live verify race to its timeout. */
  async function driveLiveJobToTimeout(
    jobId: string,
    configure: () => { transport: NostrTransport; triggerJob: (job: IncomingJob) => void },
    targetLedger: JobLedger = ledger,
  ): Promise<{ transport: NostrTransport; skill: Skill }> {
    const skill = makePaidSkill();
    const { transport, triggerJob } = configure();
    // 999s recovery interval: only the startup tick runs, so nothing but the
    // LIVE path can touch the entry inside the test.
    const runtime = makeRuntime(skill, transport, targetLedger, {
      paymentTimeoutSecs: 1,
      recoveryIntervalSecs: 999,
    });

    const runPromise = runtime.run();
    await tick();
    triggerJob(makeJob(jobId));
    await waitFor(
      () => errorMessages(transport, jobId).includes(PAYMENT_TIMEOUT_CUSTOMER_MESSAGE),
      'the live job timed out',
      NEXT_TICK_MS,
    );
    runtime.stop();
    await runPromise.catch(() => {});
    return { transport, skill };
  }

  it('leaves an unpaid job RECOVERABLE, and recovery is what closes it', async () => {
    // The SDK's reference path reports the same conclusive "no matching
    // transaction" whether the reference is untouched or merely carries
    // transactions it could not verify, and it cannot skip the signatures this
    // provider already gave to other jobs. Only recovery can, so only recovery
    // may end the job.
    refPathVerify = () => ({ verified: false, error: DEFINITIVE_NO_PAYMENT });
    refScanEntries = [];
    const { skill } = await driveLiveJobToTimeout('live-unpaid', () =>
      makeFakeTransport(always(null)),
    );

    expect(ledger.getStatus('live-unpaid')).toBe('paid');
    expect(skill.execute).not.toHaveBeenCalled();
    // The live path ran no reference scan of its own - that work belongs to
    // recovery, which alone can skip consumed candidates.
    expect(refScanCalls).toBe(0);
    // The operator gets what each path actually reported, verbatim - no canned
    // classification, and nothing that depends on matching an SDK message.
    expect(logged(new RegExp(`reference path: ${DEFINITIVE_NO_PAYMENT}`))).toBe(true);
    expect(logged(/no payment-completed feedback/)).toBe(true);

    // ...and the job really is closed, by the next recovery tick.
    const rebootLedger = new JobLedger(ledgerPath);
    const recoverySkill = makePaidSkill();
    const { transport } = makeFakeTransport(always(null));
    const recoveryRuntime = makeRuntime(recoverySkill, transport, rebootLedger, {
      recoveryIntervalSecs: 1,
    });
    const recoveryRun = recoveryRuntime.run();
    await waitFor(
      () => rebootLedger.getStatus('live-unpaid') === 'failed',
      'recovery issued the terminal verdict',
      BACKOFF_MS,
    );
    recoveryRuntime.stop();
    await recoveryRun.catch(() => {});
  }, 30_000);

  it('a refused sig-path claim plus an empty reference path is logged as a REFUSAL, not as non-payment', async () => {
    // The customer asserted a signature that verified on-chain, and it belonged
    // to another job. The SDK's reference path meanwhile reports its conclusive
    // "nothing here". Reading that as "the customer never paid" would put the
    // calm line on a job where money demonstrably moved - and, before the live
    // path stopped going terminal, force-failed it outright.
    seedConsumedSettlement(ledger, 'stranger-job', SHARED_SIGNATURE);
    refPathVerify = () => ({ verified: false, error: DEFINITIVE_NO_PAYMENT });
    const { skill } = await driveLiveJobToTimeout('asserted-but-refused', () =>
      makeFakeTransport(always(SHARED_SIGNATURE)),
    );

    expect(logged(/already consumed by another job/)).toBe(true);
    // The REFUSAL branch, not the generic RPC report: the two are exclusive in
    // `handlePayment`'s timeout log, and pointing the operator at "we could not
    // reach the chain" on a job where money demonstrably moved sends them away
    // from the one line worth reading.
    expect(logged(/Payment not accepted/)).toBe(true);
    expect(logged(/WARNING: Payment verification timed out/)).toBe(false);
    expect(ledger.getStatus('asserted-but-refused')).toBe('paid');
    expect(skill.execute).not.toHaveBeenCalled();
  });

  it('a verification we cannot NAME is logged as a refusal, not as non-payment', async () => {
    // A strategy reporting `verified: true` without a settlement signature is
    // broken, not a customer state - and a payment it claims to have seen is the
    // opposite of "nothing suggests they paid". The operator must be sent to the
    // REFUSED line rather than told the customer never paid. Only the SDK's own
    // reference path can produce this: the signature path claims the transaction
    // it asked about regardless of what comes back.
    refPathVerify = () => ({ verified: true });
    const { skill } = await driveLiveJobToTimeout('nameless-live', () =>
      makeFakeTransport(always(null)),
    );

    expect(logged(/verified without a settlement signature/)).toBe(true);
    expect(logged(/Payment verified but NOT accepted/)).toBe(true);
    expect(logged(/WARNING: Payment verification timed out/)).toBe(false);
    expect(ledger.getStatus('nameless-live')).toBe('paid');
    expect(skill.execute).not.toHaveBeenCalled();
  });

  it('an RPC error on the reference path is never read as "the customer never paid"', async () => {
    // Only the exact definitive-no-pay literal means "nothing is on this
    // reference". An RPC outage is the provider's problem, and telling the
    // operator otherwise sends them away from the one thing worth checking.
    refPathVerify = () => ({ verified: false, error: 'Verification failed: 503 from RPC' });
    const { skill } = await driveLiveJobToTimeout('live-rpc-down', () =>
      makeFakeTransport(always(null)),
    );

    expect(logged(/WARNING: Payment verification timed out/)).toBe(true);
    // The mirror of the two tests above: nothing was verified here, so neither
    // refusal line may appear - an RPC outage must not be dressed up as a
    // settlement we turned down.
    expect(logged(/Payment not accepted/)).toBe(false);
    expect(logged(/Payment verified but NOT accepted/)).toBe(false);
    expect(ledger.getStatus('live-rpc-down')).toBe('paid');
    expect(skill.execute).not.toHaveBeenCalled();
  });
});
