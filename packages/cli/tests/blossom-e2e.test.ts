/**
 * E2e for the encrypted Blossom file transport through a live CLI AgentRuntime, with a mocked
 * in-memory BlossomService (no network) and mocked Nostr delivery + Solana payment (as in
 * iroh-e2e.test.ts). Provider + customer are real Nostr identities so NIP-44 key-wrap is exercised.
 *
 *   OUTPUT: provider seeds a file result to BOTH iroh and encrypted-Blossom -> the customer
 *           decrypts the blossom member back to the original bytes. (Needs the iroh addon.)
 *   INPUT:  customer encrypts a file input to the provider (blossom-ONLY, no iroh) -> provider
 *           recovery fetches + decrypts it and hands it to the skill. (No iroh addon needed - the
 *           whole point: file jobs over plain HTTP.)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEncryptedFileInput,
  createBlossomTransport,
  ElisymIdentity,
  encodeJobPayload,
  fetchEncryptedFileOutput,
  NATIVE_SOL,
  type BlossomService,
  type FileAttachment,
} from '@elisym/sdk';
import { createIrohTransport, type IrohBlobTransport } from '@elisym/sdk/node';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobLedger } from '../src/ledger.js';
import { AgentRuntime, type RuntimeConfig } from '../src/runtime.js';
import { SkillRegistry } from '../src/skill';
import type { Skill } from '../src/skill';
import type { IncomingJob, NostrTransport } from '../src/transport/nostr.js';

let mockVerifyResult: { verified: boolean; txSignature?: string } = {
  verified: true,
  txSignature: 'tx123',
};

vi.mock('@elisym/sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
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
  createSolanaRpc: vi.fn().mockReturnValue({ getTransaction: vi.fn() }),
}));

async function irohAvailable(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'elisym-bz-probe-'));
  const probe = join(dir, 'probe');
  writeFileSync(probe, 'x');
  const transport = createIrohTransport({ storePath: dir });
  try {
    await transport.seedPath(probe);
    return true;
  } catch {
    return false;
  } finally {
    await transport.shutdown().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
const addonAvailable = await irohAvailable();

const tick = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const config: RuntimeConfig = {
  paymentTimeoutSecs: 30,
  maxConcurrentJobs: 2,
  recoveryMaxRetries: 3,
  recoveryIntervalSecs: 999,
  network: 'devnet',
};

// In-memory fake BlossomService: stores uploaded ciphertext by sha256, serves it via download() and
// re-verifies the sha256 of the bytes it returns (like the real bounded download).
function fakeBlossom() {
  const store = new Map<string, Uint8Array>();
  const hashHex = async (bytes: Uint8Array): Promise<string> => {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const svc = {
    async upload(_identity: ElisymIdentity, blob: Blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha256 = await hashHex(bytes);
      store.set(sha256, bytes);
      return {
        url: `https://files.elisym.network/${sha256}.bin`,
        sha256,
        size: bytes.byteLength,
        type: blob.type,
        provider: 'blossom',
      };
    },
    async download(url: string, opts?: { maxBytes?: number; expectedSha256?: string }) {
      const sha = url.split('/').pop()?.replace('.bin', '') ?? '';
      const bytes = store.get(sha);
      if (!bytes) {
        throw new Error('not found');
      }
      if (opts?.expectedSha256 !== undefined && opts.expectedSha256 !== (await hashHex(bytes))) {
        throw new Error('Download integrity check failed');
      }
      return bytes;
    },
  };
  return svc as unknown as BlossomService;
}

function makeRegistry(skill: Skill): SkillRegistry {
  return {
    register: vi.fn(),
    route: vi.fn().mockReturnValue(skill),
    allCapabilities: vi.fn().mockReturnValue(['text-gen']),
  } as unknown as SkillRegistry;
}

function makeTransport(): {
  transport: NostrTransport;
  triggerJob: (job: IncomingJob) => void;
  deliverResult: ReturnType<typeof vi.fn>;
} {
  let onJobCb: ((job: IncomingJob) => void) | null = null;
  const deliverResult = vi.fn().mockResolvedValue('result-event-id');
  const transport = {
    start: vi.fn((cb: (job: IncomingJob) => void) => {
      onJobCb = cb;
    }),
    stop: vi.fn(),
    sendFeedback: vi.fn().mockResolvedValue(undefined),
    deliverResult,
    waitForPaymentSignature: vi.fn().mockImplementation(
      (_jobId: string, _customer: string, signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          signal.addEventListener('abort', () => resolve(null), { once: true });
        }),
    ),
  } as unknown as NostrTransport;
  return { transport, triggerJob: (job: IncomingJob) => onJobCb?.(job), deliverResult };
}

describe('encrypted Blossom file transport e2e', () => {
  let work: string;
  const irohTransports: IrohBlobTransport[] = [];

  beforeEach(() => {
    mockVerifyResult = { verified: true, txSignature: 'tx123' };
    work = mkdtempSync(join(tmpdir(), 'elisym-bz-work-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });
  afterAll(async () => {
    await Promise.all(irohTransports.map((t) => t.shutdown().catch(() => {})));
  }, 30_000);

  const outputIt = addonAvailable ? it : it.skip;
  outputIt(
    'OUTPUT: seeds a file result to iroh + encrypted-Blossom; customer decrypts the blossom member',
    async () => {
      const provider = ElisymIdentity.generate();
      const customer = ElisymIdentity.generate();
      const blossom = fakeBlossom();

      const irohDir = mkdtempSync(join(tmpdir(), 'elisym-bz-iroh-'));
      const irohTransport = createIrohTransport({ storePath: irohDir });
      irohTransports.push(irohTransport);
      const blossomTransport = createBlossomTransport({ blossom, identity: provider });

      const payload = `result-${'z'.repeat(2048)}`;
      const resultFile = join(work, 'result.bin');
      writeFileSync(resultFile, payload);

      const skill: Skill = {
        name: 'file-producer',
        description: 'returns a file result',
        capabilities: ['text-gen'],
        priceSubunits: 0,
        asset: NATIVE_SOL,
        execute: vi.fn().mockResolvedValue({
          data: '',
          filePath: resultFile,
          outputMime: 'application/octet-stream',
        }),
      };
      const ledger = new JobLedger(join(work, '.jobs.json'));
      const { transport, triggerJob, deliverResult } = makeTransport();
      const runtime = new AgentRuntime(
        transport,
        makeRegistry(skill),
        { llm: null as never, agentName: 'p', agentDescription: '' },
        config,
        ledger,
        { onLog: vi.fn() },
        undefined,
        irohTransport,
        provider,
        blossomTransport,
      );

      const runPromise = runtime.run();
      await tick(20);
      const job: IncomingJob = {
        jobId: 'out-job',
        input: 'please produce',
        inputType: 'text',
        tags: ['elisym', 'text-gen'],
        customerId: customer.publicKey,
        encrypted: false,
        rawEvent: {
          id: 'out-job',
          pubkey: customer.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 5100,
          tags: [['t', 'elisym']],
          content: 'please produce',
          sig: 'sig',
        },
      };
      triggerJob(job);
      await tick(1500);
      runtime.stop();
      await runPromise.catch(() => {});

      expect(deliverResult).toHaveBeenCalledTimes(1);
      const attachment = deliverResult.mock.calls[0]![3] as FileAttachment | undefined;
      expect(attachment).toBeDefined();
      // Blossom preferred (first), iroh as the fallback.
      expect(attachment!.transports.map((t) => t.kind)).toEqual(['blossom', 'iroh']);

      const out = await fetchEncryptedFileOutput({
        attachment: attachment!,
        providerPubkey: provider.publicKey,
        identity: customer,
        blossom,
      });
      expect(new TextDecoder().decode(out.bytes)).toBe(payload);
    },
    60_000,
  );

  outputIt(
    "OUTPUT: an accept:['iroh'] advertisement narrows to iroh-only (no Blossom upload)",
    async () => {
      const provider = ElisymIdentity.generate();
      const customer = ElisymIdentity.generate();
      const blossom = fakeBlossom();
      const uploadSpy = vi.spyOn(blossom, 'upload');

      const irohDir = mkdtempSync(join(tmpdir(), 'elisym-bz-iroh-'));
      const irohTransport = createIrohTransport({ storePath: irohDir });
      irohTransports.push(irohTransport);
      const blossomTransport = createBlossomTransport({ blossom, identity: provider });

      const resultFile = join(work, 'result.bin');
      writeFileSync(resultFile, 'narrowed-result');

      const skill: Skill = {
        name: 'file-producer',
        description: 'returns a file result',
        capabilities: ['text-gen'],
        priceSubunits: 0,
        asset: NATIVE_SOL,
        execute: vi.fn().mockResolvedValue({
          data: '',
          filePath: resultFile,
          outputMime: 'application/octet-stream',
        }),
      };
      const ledger = new JobLedger(join(work, '.jobs.json'));
      const { transport, triggerJob, deliverResult } = makeTransport();
      const runtime = new AgentRuntime(
        transport,
        makeRegistry(skill),
        { llm: null as never, agentName: 'p', agentDescription: '' },
        config,
        ledger,
        { onLog: vi.fn() },
        undefined,
        irohTransport,
        provider,
        blossomTransport,
      );

      const runPromise = runtime.run();
      await tick(20);
      triggerJob({
        jobId: 'out-iroh',
        input: 'please produce',
        inputType: 'text',
        tags: ['elisym', 'text-gen'],
        customerId: customer.publicKey,
        encrypted: false,
        rawEvent: {
          id: 'out-iroh',
          pubkey: customer.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 5100,
          tags: [
            ['t', 'elisym'],
            ['accept', 'iroh'],
          ],
          content: 'please produce',
          sig: 'sig',
        },
      });
      await tick(1500);
      runtime.stop();
      await runPromise.catch(() => {});

      const attachment = deliverResult.mock.calls[0]![3] as FileAttachment | undefined;
      expect(attachment!.transports.map((t) => t.kind)).toEqual(['iroh']);
      // The win: advertising iroh-only means the provider never uploaded to Blossom.
      expect(uploadSpy).not.toHaveBeenCalled();
    },
    60_000,
  );

  it('INPUT: provider (recovery) fetches + decrypts a blossom-only encrypted input (no iroh)', async () => {
    const provider = ElisymIdentity.generate();
    const customer = ElisymIdentity.generate();
    const blossom = fakeBlossom();
    const blossomTransport = createBlossomTransport({ blossom, identity: provider });

    const payloadText = 'secret encrypted input over http';
    const file = Object.assign(new Blob([payloadText], { type: 'text/plain' }), {
      name: 'input.txt',
    });
    // Customer encrypts the input to the provider -> blossom-only attachment.
    const attachment = await buildEncryptedFileInput({
      file,
      providerPubkey: provider.publicKey,
      identity: customer,
      blossom,
    });
    expect(attachment.transports.map((t) => t.kind)).toEqual(['blossom']);

    const skill: Skill = {
      name: 'text-consumer',
      description: 'echoes its inline data',
      capabilities: ['text-gen'],
      priceSubunits: 100_000,
      asset: NATIVE_SOL,
      execute: vi
        .fn()
        .mockImplementation((input: { data: string }) => Promise.resolve({ data: input.data })),
    };

    const ledger = new JobLedger(join(work, '.jobs.json'));
    const rawEvent = {
      id: 'in-job',
      pubkey: customer.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 5100,
      tags: [
        ['t', 'elisym'],
        ['t', 'text-gen'],
      ],
      content: encodeJobPayload({ attachment }),
      sig: 'sig',
    };
    ledger.recordPaid({
      job_id: 'in-job',
      input: '',
      input_type: 'text',
      tags: ['elisym', 'text-gen'],
      customer_id: customer.publicKey,
      net_amount: 9_700_000,
      raw_event_json: JSON.stringify(rawEvent),
      created_at: Math.floor(Date.now() / 1000),
    });

    const { transport, deliverResult } = makeTransport();
    // No iroh transport - proves a blossom-only input works without the addon.
    const runtime = new AgentRuntime(
      transport,
      makeRegistry(skill),
      { llm: null as never, agentName: 'p', agentDescription: '' },
      config,
      ledger,
      { onLog: vi.fn() },
      undefined,
      undefined,
      provider,
      blossomTransport,
    );

    const runPromise = runtime.run();
    await tick(2000);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).toHaveBeenCalledTimes(1);
    const skillInput = (skill.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      data: string;
    };
    expect(skillInput.data).toBe(payloadText);
    expect(deliverResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'in-job' }),
      payloadText,
      9_700_000,
      undefined,
    );
  }, 30_000);
});
