/**
 * Which list `sign_onchain_call` refuses on, driven THROUGH the tool: only
 * `verifyOnchainCall` is mocked, so the call site in `previewCall` - the line a
 * hostile transaction actually reaches - is what these tests pin. The helpers it
 * calls have unit tests of their own; those stay green when the wiring is wrong.
 */
import {
  DEFAULT_KIND_OFFSET,
  KIND_JOB_REQUEST_BASE,
  ONCHAIN_AUTHORITY_CHANGE_NOTICE,
  ONCHAIN_UNATTRIBUTED_NOTICE,
  generateSolanaWallet,
} from '@elisym/sdk';
import { getBase58Encoder } from '@solana/kit';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { onchainTools } from '../src/tools/onchain.js';

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock('@elisym/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@elisym/sdk')>()),
  verifyOnchainCall: verifyMock,
}));

const PROVIDER_PUBKEY = 'a'.repeat(64);
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const POOL_STATE = '5rWZFsmzGkVpS8N7hBhKrnBEEbLKWUYUCiTeXPQVCVCv';
const VAULT = '4ARYGgibfQDcERcBj8E8pjcoE5SmeHXsAHe2HhQmKxYV';
const CUSTOMER_SECRET_KEY = generateSecretKey();
const CUSTOMER_PUBKEY = getPublicKey(CUSTOMER_SECRET_KEY);
const JOB_REQUEST = finalizeEvent(
  {
    kind: KIND_JOB_REQUEST_BASE + DEFAULT_KIND_OFFSET,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', PROVIDER_PUBKEY],
      ['t', 'elisym'],
      ['t', 'withdraw'],
    ],
    content: 'stub',
  },
  CUSTOMER_SECRET_KEY,
);

const descriptor = {
  network: 'devnet',
  kind: 'withdraw',
  programs: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
  requires: [],
  params: [],
  token: 'usdc',
  mint: USDC_MINT,
  decimals: 6,
  symbol: 'USDC',
  max_per_call_subunits: '500000000',
  grants_authority: false,
  max_authority_subunits: '0',
};

const PRIOR = process.env.ELISYM_ALLOW_ONCHAIN_SIGNING;
beforeAll(() => {
  process.env.ELISYM_ALLOW_ONCHAIN_SIGNING = '1';
});
afterAll(() => {
  if (PRIOR === undefined) {
    delete process.env.ELISYM_ALLOW_ONCHAIN_SIGNING;
  } else {
    process.env.ELISYM_ALLOW_ONCHAIN_SIGNING = PRIOR;
  }
});

async function agent(): Promise<AgentInstance> {
  const wallet = await generateSolanaWallet();
  return {
    client: {
      pool: { queryByIds: vi.fn(async () => [JOB_REQUEST]) },
      discovery: {
        fetchAgent: vi.fn(async () => ({
          pubkey: PROVIDER_PUBKEY,
          npub: nip19.npubEncode(PROVIDER_PUBKEY),
          cards: [{ name: 'withdraw', onchain: descriptor }],
        })),
      },
      marketplace: {
        queryJobResults: vi.fn(
          async () =>
            new Map([
              [
                JOB_REQUEST.id,
                { content: '{}', senderPubkey: PROVIDER_PUBKEY, decryptionFailed: false },
              ],
            ]),
        ),
      },
    } as never,
    identity: { publicKey: CUSTOMER_PUBKEY, secretKey: CUSTOMER_SECRET_KEY } as never,
    name: 'stub',
    network: 'devnet',
    security: {},
    solanaKeypair: {
      publicKey: 'stub',
      secretKey: new Uint8Array(getBase58Encoder().encode(wallet.secretKeyBase58)),
    },
  } as never;
}

function verified(facts: Record<string, unknown>) {
  verifyMock.mockResolvedValueOnce({
    ok: true,
    transaction: 'AQ==',
    lifetime: { blockhash: 'x', lastValidBlockHeight: 1n },
    signer: 'stub',
    ceilings: {
      spendSubunits: 500_000_000n,
      authoritySubunits: 0n,
      incidentalLamports: 45_000_000n,
    },
    facts: {
      programs: [],
      innerPrograms: [],
      instructionCount: 1,
      deltas: [],
      grants: [],
      feeLamports: 5_000n,
      ...facts,
    },
  });
}

async function preview(input: Record<string, unknown> = {}) {
  const ctx = new AgentContext();
  ctx.register(await agent());
  const tool = onchainTools.find((candidate) => candidate.name === 'sign_onchain_call');
  const result = await tool?.handler(ctx, {
    job_id: JOB_REQUEST.id,
    kind_offset: 100,
    ...input,
  } as never);
  return { isError: result?.isError === true, text: String(result?.content[0]?.text) };
}

describe('sign_onchain_call through the tool - which list refuses by default', () => {
  it('previews a swap-shaped call: wide list printed, notice said, a nonce issued', async () => {
    verified({ unattributed: [POOL_STATE, VAULT], unattributedAuthority: [] });
    const result = await preview();
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`Accounts elisym could not attribute: ${POOL_STATE}, ${VAULT}`);
    expect(result.text).toContain(ONCHAIN_UNATTRIBUTED_NOTICE);
    expect(result.text).not.toContain(ONCHAIN_AUTHORITY_CHANGE_NOTICE);
    expect(result.text).not.toContain('change hands');
    expect(result.text).toContain('nonce="');
  });

  it('refuses an authority change by default, names ONLY those accounts, issues no nonce', async () => {
    verified({ unattributed: [POOL_STATE, VAULT], unattributedAuthority: [VAULT] });
    const result = await preview();
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Accounts: ${VAULT}`);
    expect(result.text).not.toContain(POOL_STATE);
    expect(result.text).not.toContain('nonce="');
  });

  it('falls back to the WIDE list when the facts carry no narrow one (fail closed)', async () => {
    verified({ unattributed: [POOL_STATE] });
    const result = await preview();
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Accounts: ${POOL_STATE}`);
    expect(result.text).not.toContain('nonce="');
  });

  it('signs it only on accept_unattributed, and says again what was accepted', async () => {
    verified({ unattributed: [POOL_STATE, VAULT], unattributedAuthority: [VAULT] });
    const result = await preview({ accept_unattributed: true });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`Accounts that change hands (accepted by you): ${VAULT}`);
    expect(result.text).toContain(ONCHAIN_AUTHORITY_CHANGE_NOTICE);
    expect(result.text).toContain('nonce="');
  });
});
