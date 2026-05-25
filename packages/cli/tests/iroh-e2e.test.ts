/**
 * Cross-package e2e for iroh file transfer: a live CLI AgentRuntime (provider)
 * seeds / fetches files through a REAL iroh node, and a second REAL iroh node
 * (the customer) is on the other end. Nostr delivery and Solana payment are
 * mocked (as in runtime.test.ts) so the test isolates the file-transfer path.
 *
 *   OUTPUT: provider runtime seeds a skill's file result -> customer node fetches
 *           it by the delivered ticket -> bytes match.
 *   INPUT:  customer node seeds an input file -> provider runtime (recovery path,
 *           already paid) fetches it and hands the local path to the skill, which
 *           reads it back -> bytes match.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_SOL, encodeJobPayload, type FileAttachment } from '@elisym/sdk';
import { createIrohTransport, type IrohBlobTransport } from '@elisym/sdk/node';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobLedger } from '../src/ledger.js';
import { AgentRuntime, type RuntimeConfig } from '../src/runtime.js';
import { SkillRegistry } from '../src/skill';
import type { Skill } from '../src/skill';
import { DynamicScriptSkill } from '../src/skill/non-llm-skills.js';
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

// Gate on the optional native addon by exercising the REAL transport path (it
// resolves @number0/iroh relative to the SDK, which holds the optionalDependency -
// importing it directly from this package would not resolve in the workspace layout).
async function irohAvailable(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'elisym-e2e-probe-'));
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

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
const tick = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const config: RuntimeConfig = {
  paymentTimeoutSecs: 30,
  maxConcurrentJobs: 2,
  recoveryMaxRetries: 3,
  recoveryIntervalSecs: 999,
  network: 'devnet',
};

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

const maybe = addonAvailable ? describe : describe.skip;

maybe('iroh file transfer e2e (provider runtime <-> customer node)', () => {
  let work: string;
  const transports: IrohBlobTransport[] = [];

  const newTransport = (): IrohBlobTransport => {
    const dir = mkdtempSync(join(tmpdir(), 'elisym-e2e-iroh-'));
    const transport = createIrohTransport({ storePath: dir });
    transports.push(transport);
    return transport;
  };

  beforeEach(() => {
    mockVerifyResult = { verified: true, txSignature: 'tx123' };
    work = mkdtempSync(join(tmpdir(), 'elisym-e2e-work-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });
  afterAll(async () => {
    // Parallel shutdown: several tests each create two nodes, so a sequential
    // teardown can exceed the default 10s hook timeout.
    await Promise.all(transports.map((transport) => transport.shutdown().catch(() => {})));
  }, 30_000);

  it('OUTPUT: provider seeds a file result that the customer fetches by ticket', async () => {
    const providerTransport = newTransport();
    const customerTransport = newTransport();

    const payload = randomBytes(64 * 1024);
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
      providerTransport,
    );

    const runPromise = runtime.run();
    await tick(20);
    triggerJob(makeIncomingJob('out-job', 'please produce'));
    await tick(1500);
    runtime.stop();
    await runPromise.catch(() => {});

    // The result was delivered with a file attachment, not inlined.
    expect(deliverResult).toHaveBeenCalledTimes(1);
    const attachment = deliverResult.mock.calls[0]![3] as FileAttachment | undefined;
    expect(attachment).toBeDefined();
    const ticket = attachment!.transports.find((t) => t.kind === 'iroh')?.ticket;
    expect(typeof ticket).toBe('string');

    // The customer node fetches the blob by the delivered ticket.
    const dest = join(work, 'fetched.bin');
    await customerTransport.fetchToPath(ticket!, dest);
    expect(sha256(readFileSync(dest))).toBe(sha256(payload));
  }, 60_000);

  it('OUTPUT (large text): a large text result spills to iroh, delivered as empty content + text/plain', async () => {
    const providerTransport = newTransport();
    const customerTransport = newTransport();

    // Over MAX_ENCRYPTED_INLINE_BYTES (60_000) so it spills instead of inlining.
    const largeText = `big-result-${'x'.repeat(70_000)}`;

    const skill: Skill = {
      name: 'text-producer',
      description: 'returns a large text result',
      capabilities: ['text-gen'],
      priceSubunits: 0,
      asset: NATIVE_SOL,
      execute: vi.fn().mockResolvedValue({ data: largeText }),
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
      providerTransport,
    );

    const runPromise = runtime.run();
    await tick(20);
    triggerJob(makeIncomingJob('out-text-job', 'produce a lot'));
    await tick(1500);
    runtime.stop();
    await runPromise.catch(() => {});

    // Delivered with EMPTY content (so the encrypted event never trips the byte
    // cap) plus a text/plain attachment carrying the spilled text.
    expect(deliverResult).toHaveBeenCalledTimes(1);
    expect(deliverResult.mock.calls[0]![1]).toBe('');
    const attachment = deliverResult.mock.calls[0]![3] as FileAttachment | undefined;
    expect(attachment?.mime).toBe('text/plain');
    const ticket = attachment!.transports.find((t) => t.kind === 'iroh')?.ticket;

    // The customer node fetches the spilled text and decodes it to the original.
    const fetched = await customerTransport.fetchToBytes(ticket!, { maxBytes: 4 * 1024 * 1024 });
    expect(Buffer.from(fetched).toString('utf8')).toBe(largeText);
  }, 60_000);

  it('RECOVERY (large text): re-executed large text result re-delivers empty content + ticket (no byte-cap crash)', async () => {
    const providerTransport = newTransport();
    const customerTransport = newTransport();

    const largeText = `recovered-result-${'y'.repeat(70_000)}`;

    const skill: Skill = {
      name: 'text-producer',
      description: 'returns a large text result',
      capabilities: ['text-gen'],
      priceSubunits: 100_000,
      asset: NATIVE_SOL,
      execute: vi.fn().mockResolvedValue({ data: largeText }),
    };

    const ledger = new JobLedger(join(work, '.jobs.json'));
    const rawEvent = {
      id: 'recover-text-job',
      pubkey: 'cust',
      created_at: Math.floor(Date.now() / 1000),
      kind: 5100,
      tags: [
        ['t', 'elisym'],
        ['t', 'text-gen'],
      ],
      content: 'produce a lot',
      sig: 'sig',
    };
    // A PAID entry: recovery re-executes the skill, which produces large text -
    // the provider must spill it and re-deliver EMPTY content, not the full text
    // (which would re-trip the NIP-44 byte cap on the encrypted result).
    ledger.recordPaid({
      job_id: 'recover-text-job',
      input: 'produce a lot',
      input_type: 'text',
      tags: ['elisym', 'text-gen'],
      customer_id: 'cust',
      net_amount: 9_700_000,
      raw_event_json: JSON.stringify(rawEvent),
      created_at: Math.floor(Date.now() / 1000),
    });

    const { transport, deliverResult } = makeTransport();
    const runtime = new AgentRuntime(
      transport,
      makeRegistry(skill),
      { llm: null as never, agentName: 'p', agentDescription: '' },
      config,
      ledger,
      { onLog: vi.fn() },
      undefined,
      providerTransport,
    );

    const runPromise = runtime.run();
    await tick(2000);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).toHaveBeenCalledTimes(1);
    expect(deliverResult).toHaveBeenCalledTimes(1);
    expect(deliverResult.mock.calls[0]![1]).toBe('');
    const attachment = deliverResult.mock.calls[0]![3] as FileAttachment | undefined;
    expect(attachment?.mime).toBe('text/plain');
    const ticket = attachment!.transports.find((t) => t.kind === 'iroh')?.ticket;
    const fetched = await customerTransport.fetchToBytes(ticket!, { maxBytes: 4 * 1024 * 1024 });
    expect(Buffer.from(fetched).toString('utf8')).toBe(largeText);
  }, 60_000);

  it('INPUT (binary): provider (recovery, already paid) fetches a customer-seeded file for the skill', async () => {
    const providerTransport = newTransport();
    const customerTransport = newTransport();

    const payloadText = `secret-input-${randomBytes(8).toString('hex')}`;
    const inputFile = join(work, 'input.bin');
    writeFileSync(inputFile, payloadText);

    // Customer seeds the input file and builds the attachment descriptor. A
    // binary (application/octet-stream) input streams to a temp file - it is NOT
    // re-inlined - so the skill receives a `filePath`.
    const seeded = await customerTransport.seedPath(inputFile);
    const attachment: FileAttachment = {
      name: 'input.bin',
      size: seeded.size,
      mime: 'application/octet-stream',
      transports: [{ kind: 'iroh', ticket: seeded.ticket }],
    };

    // The skill reads its file input back out so we can assert it was fetched.
    const skill: Skill = {
      name: 'file-consumer',
      description: 'reads a file input',
      capabilities: ['text-gen'],
      priceSubunits: 100_000,
      asset: NATIVE_SOL,
      execute: vi.fn().mockImplementation((input: { filePath?: string }) =>
        Promise.resolve({
          data: input.filePath ? readFileSync(input.filePath, 'utf-8') : 'NO_FILE',
        }),
      ),
    };

    const ledger = new JobLedger(join(work, '.jobs.json'));
    // Pre-populate a PAID job whose raw event content is the file-input envelope,
    // so the recovery path re-executes it: decode the attachment, fetch it via
    // iroh (post-payment), and hand the local path to the skill.
    const rawEvent = {
      id: 'in-job',
      pubkey: 'cust',
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
      customer_id: 'cust',
      net_amount: 9_700_000,
      raw_event_json: JSON.stringify(rawEvent),
      created_at: Math.floor(Date.now() / 1000),
    });

    const { transport, deliverResult } = makeTransport();
    const runtime = new AgentRuntime(
      transport,
      makeRegistry(skill),
      { llm: null as never, agentName: 'p', agentDescription: '' },
      config,
      ledger,
      { onLog: vi.fn() },
      undefined,
      providerTransport,
    );

    const runPromise = runtime.run();
    await tick(2000); // recovery runs at startup; allow the fetch + execute
    runtime.stop();
    await runPromise.catch(() => {});

    // The skill received the fetched file and read its content back.
    expect(skill.execute).toHaveBeenCalledTimes(1);
    const skillInput = (skill.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      filePath?: string;
    };
    expect(typeof skillInput.filePath).toBe('string');
    expect(deliverResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'in-job' }),
      payloadText,
      9_700_000,
      undefined,
    );
  }, 60_000);

  it('INPUT (text): a text/plain input is transparently re-inlined into SkillInput.data (no filePath)', async () => {
    const providerTransport = newTransport();
    const customerTransport = newTransport();

    const payloadText = `large-text-input-${randomBytes(16).toString('hex')}`;
    const inputFile = join(work, 'input.txt');
    writeFileSync(inputFile, payloadText);

    // A text/plain input within the re-inline ceiling is fetched into memory and
    // handed to the skill as `data` (not a filePath), so skills are unchanged.
    const seeded = await customerTransport.seedPath(inputFile);
    const attachment: FileAttachment = {
      name: 'input.txt',
      size: seeded.size,
      mime: 'text/plain',
      transports: [{ kind: 'iroh', ticket: seeded.ticket }],
    };

    // The skill echoes its `data` so we can assert it was re-inlined (not a file).
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
      id: 'in-text-job',
      pubkey: 'cust',
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
      job_id: 'in-text-job',
      input: '',
      input_type: 'text',
      tags: ['elisym', 'text-gen'],
      customer_id: 'cust',
      net_amount: 9_700_000,
      raw_event_json: JSON.stringify(rawEvent),
      created_at: Math.floor(Date.now() / 1000),
    });

    const { transport, deliverResult } = makeTransport();
    const runtime = new AgentRuntime(
      transport,
      makeRegistry(skill),
      { llm: null as never, agentName: 'p', agentDescription: '' },
      config,
      ledger,
      { onLog: vi.fn() },
      undefined,
      providerTransport,
    );

    const runPromise = runtime.run();
    await tick(2000);
    runtime.stop();
    await runPromise.catch(() => {});

    expect(skill.execute).toHaveBeenCalledTimes(1);
    const skillInput = (skill.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      data: string;
      filePath?: string;
    };
    expect(skillInput.data).toBe(payloadText);
    expect(skillInput.filePath).toBeUndefined();
    expect(deliverResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'in-text-job' }),
      payloadText,
      9_700_000,
      undefined,
    );
  }, 60_000);

  it('INPUT->OUTPUT (dynamic-script): provider fetches a file input, a script writes a file output, customer fetches it', async () => {
    const providerTransport = newTransport();
    const customerTransport = newTransport();

    // A REAL dynamic-script skill: read the fetched input from ELISYM_INPUT_FILE,
    // write a transformed result to ELISYM_OUTPUT_FILE (copy + marker), emit a note
    // on stdout. Exercises the file-in -> script -> file-out wiring end to end (the
    // same path the rembg remove-bg skill uses, minus the model).
    const scriptPath = join(work, 'transform.sh');
    writeFileSync(
      scriptPath,
      '#!/usr/bin/env bash\nset -euo pipefail\n' +
        'cat "$ELISYM_INPUT_FILE" > "$ELISYM_OUTPUT_FILE"\n' +
        'printf -- "-PROCESSED" >> "$ELISYM_OUTPUT_FILE"\n' +
        'echo "processed"\n',
    );
    chmodSync(scriptPath, 0o755);

    // Customer seeds a binary input (application/octet-stream => streamed to disk,
    // handed to the script as ELISYM_INPUT_FILE rather than re-inlined).
    const inputBytes = randomBytes(32 * 1024);
    const inputFile = join(work, 'input.bin');
    writeFileSync(inputFile, inputBytes);
    const seeded = await customerTransport.seedPath(inputFile);
    const attachment: FileAttachment = {
      name: 'input.bin',
      size: seeded.size,
      mime: 'application/octet-stream',
      transports: [{ kind: 'iroh', ticket: seeded.ticket }],
    };

    const skill = new DynamicScriptSkill({
      name: 'transform',
      description: 'reads a file input and writes a file output',
      capabilities: ['text-gen'],
      priceSubunits: 100_000,
      asset: NATIVE_SOL,
      scriptPath,
      scriptArgs: [],
      dir: work,
      outputMime: 'image/png',
    });

    const ledger = new JobLedger(join(work, '.jobs.json'));
    const rawEvent = {
      id: 'transform-job',
      pubkey: 'cust',
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
      job_id: 'transform-job',
      input: '',
      input_type: 'text',
      tags: ['elisym', 'text-gen'],
      customer_id: 'cust',
      net_amount: 9_700_000,
      raw_event_json: JSON.stringify(rawEvent),
      created_at: Math.floor(Date.now() / 1000),
    });

    const { transport, deliverResult } = makeTransport();
    const runtime = new AgentRuntime(
      transport,
      makeRegistry(skill),
      { llm: null as never, agentName: 'p', agentDescription: '' },
      config,
      ledger,
      { onLog: vi.fn() },
      undefined,
      providerTransport,
    );

    const runPromise = runtime.run();
    await tick(2500); // recovery: fetch input -> run script -> seed output -> deliver
    runtime.stop();
    await runPromise.catch(() => {});

    // Delivered with a file attachment carrying the script's output; the inline
    // note is the script's stdout, and the mime comes from the skill's output_mime.
    expect(deliverResult).toHaveBeenCalledTimes(1);
    expect(deliverResult.mock.calls[0]![1]).toBe('processed');
    const resultAttachment = deliverResult.mock.calls[0]![3] as FileAttachment | undefined;
    expect(resultAttachment?.mime).toBe('image/png');
    const ticket = resultAttachment!.transports.find((t) => t.kind === 'iroh')?.ticket;

    // The customer fetches the result and gets the transformed input bytes back.
    const dest = join(work, 'result.bin');
    await customerTransport.fetchToPath(ticket!, dest);
    const expected = Buffer.concat([inputBytes, Buffer.from('-PROCESSED')]);
    expect(sha256(readFileSync(dest))).toBe(sha256(expected));
  }, 60_000);
});

function makeIncomingJob(id: string, input: string): IncomingJob {
  return {
    jobId: id,
    input,
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
        ['i', input, 'text'],
        ['t', 'elisym'],
        ['t', 'text-gen'],
      ],
      content: input,
      sig: 'sig',
    },
  };
}
