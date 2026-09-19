/**
 * A manual `send_payment` tells the provider it was paid, whatever state the
 * local history is in.
 *
 * By the time the link runs the money is on-chain. The confirmation is what
 * lets the provider find the payment inside its verification window - about a
 * minute - and a payment driven by hand through an LLM easily outlasts that on
 * its own. The local record used to be written AHEAD of the confirmation in one
 * `try`, so anything that failed the write also silenced the provider: a
 * read-only agent directory, a directory where the history file belongs, a
 * full disk. Paid, and nobody told. That ordering is on `main`; it was found
 * here because this branch had just fixed one cause of the same failure - a
 * `.gitignore` migration that could throw - and left the structure that made
 * it matter.
 *
 * Driven through the real `send_payment` handler. Lives in its own file because
 * it mocks `@solana/kit`: what is measured is the order of two calls that sit
 * after a transaction has been sent, and no test may send one.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SolanaPaymentStrategy } from '@elisym/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentContext, fetchProtocolConfig, type AgentInstance } from '../src/context.js';
import { logger } from '../src/logger.js';
import { walletTools } from '../src/tools/wallet.js';

const WALLET = '9vSzxkCJiEuGwYnJGo17XsofAANM5GMzBg5rJquejs7o';
const RECIPIENT = '2miSgJ98vQWckZkdnBU7WtaRJQkdHY8UZJzqwC6FBFdM';
const REFERENCE = '4ARYGgibfQDcERcBj8E8pjcoE5SmeHXsAHe2HvYKvY78';
const TREASURY = 'CYWTDfv5keEpddQRkpYCuSGkzPkMRh2UWsw7zrgoC4QP';
const JOB_EVENT_ID = 'e'.repeat(64);
const CUSTOMER_PUBKEY = 'b'.repeat(64);
const PROVIDER_PUBKEY = 'a'.repeat(64);
/** Longer than any honest run, shorter than the harness: a hang reports as one. */
const HANG_AFTER_MS = 4_000;

vi.mock('../src/context.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/context.js')>();
  return { ...actual, fetchProtocolConfig: vi.fn() };
});
vi.mock('@solana/kit', async (importActual) => {
  const actual = await importActual<typeof import('@solana/kit')>();
  return {
    ...actual,
    sendAndConfirmTransactionFactory: () => async () => undefined,
    createSolanaRpcSubscriptions: () => ({}),
    getSignatureFromTransaction: () => '5'.repeat(88),
    createKeyPairSignerFromBytes: async () => ({ address: WALLET }),
    createSolanaRpc: () => ({ getBalance: () => ({ send: async () => ({ value: 1_000_000n }) }) }),
  };
});
vi.mock('nostr-tools', async (importActual) => {
  const actual = await importActual<typeof import('nostr-tools')>();
  return { ...actual, verifyEvent: () => true };
});

let sandbox: string;
let agentDir: string;
let confirmations: ReturnType<typeof vi.fn>;

function makeAgent(): AgentInstance {
  return {
    client: {
      pool: {
        queryByIds: async () => [
          {
            id: JOB_EVENT_ID,
            kind: 5100,
            pubkey: CUSTOMER_PUBKEY,
            tags: [
              ['p', PROVIDER_PUBKEY],
              ['t', 'elisym'],
              ['t', 'text-gen'],
            ],
          },
        ],
      },
      marketplace: { submitPaymentConfirmation: confirmations },
    } as never,
    identity: { publicKey: CUSTOMER_PUBKEY } as never,
    name: 'alice',
    network: 'devnet',
    security: {},
    agentDir,
    solanaKeypair: { publicKey: WALLET, secretKey: new Uint8Array(64) },
  } as AgentInstance;
}

/** The tool's reply, or `'HUNG'` - a blocked link must fail by name, not by the clock. */
async function sendLinkedPayment(): Promise<string> {
  const tool = walletTools.find((candidate) => candidate.name === 'send_payment');
  if (!tool) {
    throw new Error('send_payment is not registered');
  }
  const ctx = new AgentContext();
  ctx.register(makeAgent());
  const work = tool
    .handler(
      ctx,
      tool.schema.parse({
        payment_request: JSON.stringify({
          recipient: RECIPIENT,
          amount: 1_000,
          reference: REFERENCE,
          created_at: Math.floor(Date.now() / 1000),
          expiry_secs: 300,
          network: 'devnet',
        }),
        expected_solana_recipient: RECIPIENT,
        expected_asset: 'sol',
        job_event_id: JOB_EVENT_ID,
      }),
    )
    .then((result) => {
      const first = result.content[0];
      return first !== undefined && first.type === 'text' ? first.text : '';
    });
  const hung = new Promise<string>((resolve) => {
    setTimeout(() => resolve('HUNG'), HANG_AFTER_MS).unref?.();
  });
  return Promise.race([work, hung]);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'elisym-manual-link-'));
  agentDir = join(sandbox, '.elisym', 'alice');
  mkdirSync(agentDir, { recursive: true });
  confirmations = vi.fn(async () => undefined);
  vi.mocked(fetchProtocolConfig).mockResolvedValue({ feeBps: 0, treasury: TREASURY });
  vi.spyOn(SolanaPaymentStrategy.prototype, 'buildTransaction').mockResolvedValue({} as never);
});

afterEach(() => {
  // A row may have taken the directory's write bit; give it back or `rmSync`
  // fails and takes the next row's sandbox with it.
  try {
    chmodSync(agentDir, 0o755);
  } catch {
    /* the directory may already be gone */
  }
  rmSync(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const gitignorePath = (): string => join(sandbox, '.elisym', '.gitignore');
const historyPath = (): string => join(agentDir, '.customer-history.json');

describe('a manual payment linked to its job', () => {
  it.each([
    ['a healthy agent directory', () => undefined],
    [
      'a read-only .gitignore',
      () => {
        writeFileSync(gitignorePath(), '.secrets.json\n');
        chmodSync(gitignorePath(), 0o444);
      },
    ],
    ['a FIFO where the .gitignore belongs', () => execFileSync('mkfifo', [gitignorePath()])],
    ['a directory where the .gitignore belongs', () => mkdirSync(gitignorePath())],
    ['a FIFO where the history file belongs', () => execFileSync('mkfifo', [historyPath()])],
    ['a history file that is not JSON', () => writeFileSync(historyPath(), '{not json')],
    [
      'a read-only history file',
      () => {
        writeFileSync(historyPath(), JSON.stringify({ version: 1, jobs: [] }));
        chmodSync(historyPath(), 0o444);
      },
    ],
    // The two that used to silence the provider. Everything above them failed
    // the write in a way the store already absorbed; these fail it in a way
    // nothing can, so only the ORDER saves the confirmation.
    ['a read-only agent DIRECTORY', () => chmodSync(agentDir, 0o555)],
    ['a directory where the history file belongs', () => mkdirSync(historyPath())],
  ])('tells the provider, with %s', async (_label, arrange) => {
    if (process.getuid?.() === 0) {
      return; // root ignores the mode bits
    }
    arrange();

    const reply = await sendLinkedPayment();

    expect(reply).not.toBe('HUNG');
    expect(confirmations).toHaveBeenCalledTimes(1);
    expect(confirmations.mock.calls[0]?.[1]).toBe(JOB_EVENT_ID);
    expect(confirmations.mock.calls[0]?.[2]).toBe(PROVIDER_PUBKEY);
  });

  it('says so when the provider was told and the local record could not be written', async () => {
    // The reply is what the model relays, and "Linked" would be a lie here:
    // `submit_feedback` looks the payment up in the history that was not
    // written. The provider half did happen, and that is the half worth money.
    if (process.getuid?.() === 0) {
      return;
    }
    chmodSync(agentDir, 0o555);

    const reply = await sendLinkedPayment();

    expect(confirmations).toHaveBeenCalledTimes(1);
    expect(reply).toContain('Provider notified');
    expect(reply).not.toContain('Linked to job');
  });

  it('writes and warns nothing for a home-global agent, which has no .gitignore', async () => {
    // The other direction of the best-effort migration: a warning on every
    // write for every `~/.elisym` user would be its own regression.
    const warned = vi.spyOn(logger, 'warn');

    const reply = await sendLinkedPayment();

    expect(reply).toContain('Linked to job');
    expect(existsSync(gitignorePath())).toBe(false);
    expect(warned).not.toHaveBeenCalled();
  });
});
