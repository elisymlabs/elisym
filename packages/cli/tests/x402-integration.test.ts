import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
/**
 * Integration: the REAL @x402/fetch wrapper, @x402/core header codecs and
 * payment policies against a local x402 fixture server. Only the Solana
 * signing scheme is faked (building a real transaction needs a blockhash +
 * mint account - that is covered by the manual devnet e2e in the guide);
 * everything else - probe, driver, idempotency store, `x402 add` skill
 * generation - runs unmodified.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USDC_SOLANA_DEVNET, USDC_SOLANA_MAINNET, generateSolanaWallet } from '@elisym/sdk';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInput, X402SkillJob } from '../src/skill/index.js';
import { X402PermanentError } from '../src/x402/errors.js';
import { clearProbeCache } from '../src/x402/probe.js';
import { X402JobStore } from '../src/x402/store.js';

const mocks = vi.hoisted(() => ({
  fetchUsdcBalance: vi.fn(),
  getProtocolConfig: vi.fn(),
}));

vi.mock('../src/helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/helpers.js')>();
  return { ...original, fetchUsdcBalance: mocks.fetchUsdcBalance };
});

vi.mock('@elisym/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@elisym/sdk')>();
  return { ...original, getProtocolConfig: mocks.getProtocolConfig };
});

// Fake ONLY the Solana signing scheme: a real transaction needs a live
// blockhash and mint account. The x402Client still runs its real policy
// filter and the real PAYMENT-SIGNATURE header encoding around this.
vi.mock('@x402/svm', () => ({
  ExactSvmScheme: class FakeExactSvmScheme {
    readonly scheme = 'exact';

    async createPaymentPayload(x402Version: number) {
      return { x402Version, payload: { transaction: 'ZmFrZS1zaWduZWQtdHg=' } };
    }
  },
}));

import { cmdX402Add } from '../src/commands/x402-add.js';
import { X402Driver } from '../src/x402/driver.js';

const USDC_MINT = USDC_SOLANA_DEVNET.mint ?? '';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `getExtensionInfo` from `@x402/core`: a declaration with no `info` IS its own info. */
function declaredInfo(declaration: unknown): Record<string, unknown> {
  if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
    return {};
  }
  const record = declaration as { info?: Record<string, unknown> };
  return 'info' in record ? (record.info ?? {}) : (record as Record<string, unknown>);
}

function requiresIdentifier(declaration: unknown): boolean {
  return declaredInfo(declaration).required === true;
}

/**
 * The rule `objectContainsSubset` in `@x402/core` enforces - every advertised
 * field must come back - in a stricter, shape-agnostic form: leaves compare by
 * serialization rather than the real key-sorting `deepEqual`, so this fixture
 * can refuse an echo the real server would accept, never the reverse.
 */
function containsSubset(expected: unknown, actual: unknown): boolean {
  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
    return JSON.stringify(expected) === JSON.stringify(actual);
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    return false;
  }
  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    Object.hasOwn(actualRecord, key)
      ? containsSubset(value, actualRecord[key])
      : value === undefined,
  );
}

/** Local x402 upstream: 402 with a real v2 header when unpaid, resource when paid. */
class X402Fixture {
  private server: Server | undefined;
  quoteSubunits = 5_000n;
  /** The settlement network id + asset the fixture advertises (default devnet). */
  network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  asset = USDC_MINT;
  paidRequests = 0;
  unpaidRequests = 0;
  /** Extension block the 402 challenge advertises (undefined = none). */
  extensions: Record<string, unknown> | undefined;
  /** The last payment envelope the fixture received, and the header it arrived in. */
  echoedEnvelope: Record<string, unknown> | undefined;
  echoedHeader: string | undefined;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', resolve);
    });
    const addressInfo = this.server?.address();
    if (addressInfo === undefined || addressInfo === null || typeof addressInfo === 'string') {
      throw new Error('fixture failed to bind');
    }
    return `http://127.0.0.1:${addressInfo.port}`;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const paid =
      request.headers['payment-signature'] !== undefined ||
      request.headers['x-payment'] !== undefined;
    if (!paid) {
      this.unpaidRequests += 1;
      const header = encodePaymentRequiredHeader({
        x402Version: 2,
        error: 'PAYMENT-SIGNATURE header is required',
        resource: {
          url: 'https://api.example.com/premium-data',
          description: 'Premium market data via x402 fixture',
          serviceName: 'Fixture Market Data',
        },
        accepts: [
          {
            scheme: 'exact',
            network: this.network as never,
            amount: this.quoteSubunits.toString(),
            asset: this.asset,
            payTo: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
            maxTimeoutSeconds: 60,
            extra: { feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd' },
          },
        ],
        ...(this.extensions === undefined ? {} : { extensions: this.extensions }),
      });
      response.writeHead(402, { 'PAYMENT-REQUIRED': header, 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    this.paidRequests += 1;
    const refusal = this.extensionRefusal(request);
    if (refusal !== null) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: refusal }));
      return;
    }
    if (request.url?.startsWith('/image')) {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from(PNG_BYTES));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('bridged result');
  }

  /**
   * Both ways a real upstream refuses a payment over the extension it
   * declared: no identifier when it demanded one (Birdeye answers 400, not
   * 402), and an echo that dropped a field it advertised
   * (`validateExtensions` -> `objectContainsSubset` in `@x402/core`).
   */
  private extensionRefusal(request: IncomingMessage): string | null {
    const header = request.headers['payment-signature'];
    if (this.extensions === undefined || typeof header !== 'string') {
      return null;
    }
    let echoed: Record<string, unknown>;
    try {
      // The REAL decoder a server uses: it rejects anything outside standard
      // base64, so a re-encoding slip is refused here exactly as in production.
      const envelope = decodePaymentSignatureHeader(header) as unknown as {
        extensions?: Record<string, unknown>;
      };
      this.echoedEnvelope = envelope as Record<string, unknown>;
      this.echoedHeader = header;
      echoed = envelope.extensions ?? {};
    } catch {
      return 'invalid payment envelope';
    }
    for (const [key, advertised] of Object.entries(this.extensions)) {
      const back = echoed[key];
      if (back === undefined) {
        if (requiresIdentifier(advertised)) {
          return `missing required extension ${key}`;
        }
        continue;
      }
      if (!containsSubset(advertised, back)) {
        return `extension_echo_mismatch: ${key}`;
      }
      if (requiresIdentifier(advertised) && typeof declaredInfo(back).id !== 'string') {
        return `missing required extension ${key}`;
      }
    }
    return null;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
  }
}

// NOTE: the fixture serves plain http; the https-only rule is enforced by
// the SDK loader and the add command's URL validation (tested separately),
// while the probe/driver layer is scheme-agnostic on purpose.
describe('x402 bridge integration (real wrapper + fixture)', () => {
  const fixture = new X402Fixture();
  let baseUrl = '';
  let agentDir: string;
  let wallet: Awaited<ReturnType<typeof generateSolanaWallet>>;
  let driver: X402Driver;

  const input: SkillInput = {
    data: '{"symbol":"SOL"}',
    inputType: 'text',
    tags: ['market-data'],
    jobId: 'b'.repeat(64),
  };

  beforeAll(async () => {
    baseUrl = await fixture.start();
  });

  afterAll(async () => {
    await fixture.stop();
  });

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'elisym-x402-int-'));
    wallet = await generateSolanaWallet();
    driver = new X402Driver({
      agentDir,
      paymentsAddress: wallet.signer.address,
      solanaSecretKeyBase58: wallet.secretKeyBase58,
      rpcUrl: 'http://127.0.0.1:1/never-used',
      network: 'devnet',
      getFeeBps: async () => 250,
      log: () => {},
    });
    mocks.fetchUsdcBalance.mockResolvedValue(1_000_000n);
    fixture.quoteSubunits = 5_000n;
    fixture.paidRequests = 0;
    fixture.unpaidRequests = 0;
    fixture.extensions = undefined;
    fixture.echoedEnvelope = undefined;
    fixture.echoedHeader = undefined;
    clearProbeCache();
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function bridgeJob(): X402SkillJob {
    return {
      skillName: 'fixture-market-data',
      params: {
        url: `${baseUrl}/premium-data`,
        method: 'POST',
        queryParam: undefined,
        maxUpstreamSubunits: 10_000n,
        maxInputBytes: 100_000,
      },
      priceSubunits: 60_000,
      asset: USDC_SOLANA_DEVNET,
    };
  }

  it('runs preflight + paid call + cache against the live fixture', async () => {
    const job = bridgeJob();
    await driver.preflight(job, input);

    const result = await driver.execute(job, input);
    expect(result).toEqual({ data: 'bridged result' });
    expect(fixture.paidRequests).toBe(1);

    const store = new X402JobStore(agentDir);
    expect(await store.paidAttempts(input.jobId)).toBe(1);

    // Re-execution (the at-least-once recovery case): cache, no new payment.
    const again = await driver.execute(job, input);
    expect(again).toEqual({ data: 'bridged result' });
    expect(fixture.paidRequests).toBe(1);
  });

  it('delivers a binary upstream body as a cache-owned file result', async () => {
    const job = bridgeJob();
    job.params = { ...job.params, url: `${baseUrl}/image` };
    const result = await driver.execute(job, { ...input, jobId: 'c'.repeat(64) });
    expect(result.outputMime).toBe('image/png');
    expect(result.filePath).toBeDefined();
    const written = result.filePath === undefined ? null : await readFile(result.filePath);
    expect(written).not.toBeNull();
    expect(new Uint8Array(written ?? new Uint8Array())).toEqual(PNG_BYTES);
  });

  it('satisfies an upstream that demands a payment identifier, echo intact', async () => {
    fixture.extensions = {
      // The `?`/`>` run forces `/` and `+` into the re-encoded envelope, where
      // a slip to base64url would show - the real decoder rejects that
      // alphabet, so the fixture answers 400 exactly as a server would.
      'payment-identifier': {
        info: { required: true, scope: 'per-payment', tag: '????????>>>>>>>>' },
      },
      // A second extension the driver has no business touching. The fixture
      // holds every declared extension to the same echo rule, so dropping it
      // on the way out is a refused payment.
      bazaar: { info: { listing: 'premium-data' } },
    };

    const result = await driver.execute(bridgeJob(), input);

    expect(result).toEqual({ data: 'bridged result' });
    const echoedExtensions = fixture.echoedEnvelope?.extensions as
      | Record<string, unknown>
      | undefined;
    const echoed = echoedExtensions?.['payment-identifier'];
    expect(declaredInfo(echoed).id).toMatch(/^pay_[a-f0-9]{32}$/);
    // The declaration the server advertised came back with it - a server that
    // checks its echo (@x402/core does) would have refused the payment.
    expect(declaredInfo(echoed)).toMatchObject({
      required: true,
      scope: 'per-payment',
      tag: '????????>>>>>>>>',
    });
    expect(declaredInfo(echoedExtensions?.bazaar)).toEqual({ listing: 'premium-data' });

    // The rest of the envelope is what the server settles against - a dropped
    // `accepted` or `payload` is a burnt payment, not a failed match.
    expect(fixture.echoedEnvelope).toMatchObject({
      x402Version: 2,
      payload: { transaction: 'ZmFrZS1zaWduZWQtdHg=' },
      accepted: { scheme: 'exact', amount: '5000', asset: USDC_MINT },
      resource: { serviceName: 'Fixture Market Data' },
    });
    // Standard base64, the alphabet `@x402/core` validates the header against
    // - and this envelope really does exercise the two characters that differ.
    expect(fixture.echoedHeader ?? '').toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(fixture.echoedHeader ?? '').toContain('+');
    expect(fixture.echoedHeader ?? '').toContain('/');
  });

  it('the REAL policy filter refuses to sign after an upstream reprice above the ceiling', async () => {
    const job = bridgeJob();
    fixture.quoteSubunits = 999_999n; // above maxUpstreamSubunits
    clearProbeCache();

    await expect(driver.preflight(job, input)).rejects.toThrow(
      /no acceptable upstream payment requirement/,
    );

    // Even bypassing preflight, signing is refused by the client's policies.
    const error = await driver.execute(job, input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(X402PermanentError);
    expect((error as Error).message).toMatch(/payment refused by policy/);
    expect(fixture.paidRequests).toBe(0);
    const store = new X402JobStore(agentDir);
    expect(await store.paidAttempts(input.jobId)).toBe(0);
  });
});

describe('x402 add full cycle (temp agent, live fixture)', () => {
  const fixture = new X402Fixture();
  let baseUrl = '';
  let projectDir: string;
  let originalCwd: string;

  beforeAll(async () => {
    baseUrl = await fixture.start();
  });

  afterAll(async () => {
    await fixture.stop();
  });

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'elisym-x402-addcycle-'));
    originalCwd = process.cwd();
    // Minimal project-local agent: elisym.yaml + secrets, no wallet key yet.
    const agentDir = join(projectDir, '.elisym', 'bridge-agent');
    await mkdir(join(agentDir, 'skills'), { recursive: true });
    await writeFile(
      join(agentDir, 'elisym.yaml'),
      ['description: bridge test agent', 'relays: []', 'payments: []'].join('\n'),
    );
    await writeFile(
      join(agentDir, '.secrets.json'),
      JSON.stringify({ nostr_secret_key: '1'.repeat(64) }),
    );
    await writeFile(join(projectDir, '.elisym', '.gitignore'), '.secrets.json\n');
    mocks.getProtocolConfig.mockResolvedValue({
      feeBps: 250,
      treasury: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
      admin: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
      pendingAdmin: null,
      paused: false,
      version: 1,
    });
    mocks.fetchUsdcBalance.mockResolvedValue(1_000_000n);
    fixture.quoteSubunits = 5_000n;
    fixture.network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    fixture.asset = USDC_MINT;
    clearProbeCache();
    process.chdir(projectDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(projectDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('generates a working bridge skill non-interactively', async () => {
    await cmdX402Add(`${baseUrl}/premium-data`, 'bridge-agent', {
      yes: true,
      generateWallet: true,
      name: 'fixture-market-data',
    });

    const agentDir = join(projectDir, '.elisym', 'bridge-agent');

    // Wallet key generated and payments[] written back with the derived address.
    const secrets = JSON.parse(await readFile(join(agentDir, '.secrets.json'), 'utf-8'));
    expect(typeof secrets.solana_secret_key).toBe('string');
    const yamlText = await readFile(join(agentDir, 'elisym.yaml'), 'utf-8');
    expect(yamlText).toContain('chain: solana');
    expect(yamlText).toContain('network: devnet');

    // Gitignore migration appended the cache entries.
    const gitignore = await readFile(join(projectDir, '.elisym', '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.x402-jobs.json');
    expect(gitignore).toContain('.x402-results/');

    // The generated SKILL.md loads through the CLI loader as an x402 skill.
    const skillMd = await readFile(
      join(agentDir, 'skills', 'fixture-market-data', 'SKILL.md'),
      'utf-8',
    );
    expect(skillMd).toContain('mode: x402');
    expect(skillMd).toContain('x402_max_upstream: 5000');
    const { loadSkillsFromDir } = await import('../src/skill/loader.js');
    const skills = loadSkillsFromDir(join(agentDir, 'skills'), { network: 'devnet' });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.mode).toBe('x402');
    expect(skills[0]?.x402?.url).toBe(`${baseUrl}/premium-data`);
    // price = ceil(5000 * 11000 / 9750) = 5642 subunits
    expect(skills[0]?.priceSubunits).toBe(5_642);
  });

  it('bridges a mainnet-settling upstream for a mainnet-bound agent', async () => {
    // Mainnet-bound agent: wallet key pre-written so payments[] can carry the
    // matching address up front (the network prompt only runs interactively).
    const wallet = await generateSolanaWallet();
    const agentDir = join(projectDir, '.elisym', 'bridge-agent');
    await writeFile(
      join(agentDir, 'elisym.yaml'),
      [
        'description: bridge test agent',
        'relays: []',
        'payments:',
        '  - chain: solana',
        '    network: mainnet',
        `    address: ${wallet.signer.address}`,
      ].join('\n'),
    );
    await writeFile(
      join(agentDir, '.secrets.json'),
      JSON.stringify({
        nostr_secret_key: '1'.repeat(64),
        solana_secret_key: wallet.secretKeyBase58,
      }),
    );
    fixture.network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    fixture.asset = USDC_SOLANA_MAINNET.mint ?? '';
    clearProbeCache();

    await cmdX402Add(`${baseUrl}/premium-data`, 'bridge-agent', {
      yes: true,
      name: 'mainnet-market-data',
    });

    // The agent's elisym.yaml is fixture-owned (pre-written as mainnet above,
    // since the network prompt is interactive) - asserting on it would be
    // tautological; the load-bearing checks are the SKILL.md round-trip below.
    const skillMd = await readFile(
      join(agentDir, 'skills', 'mainnet-market-data', 'SKILL.md'),
      'utf-8',
    );
    expect(skillMd).toContain('mode: x402');
    const { loadSkillsFromDir } = await import('../src/skill/loader.js');
    const skills = loadSkillsFromDir(join(agentDir, 'skills'), { network: 'mainnet' });
    const mainnetSkill = skills.find((skill) => skill.name === 'mainnet-market-data');
    expect(mainnetSkill?.mode).toBe('x402');
    expect(mainnetSkill?.asset.mint).toBe(USDC_SOLANA_MAINNET.mint);
  });
});
