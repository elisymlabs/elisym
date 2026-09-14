/**
 * `sign_onchain_call`: the guards that hold before any chain traffic, the
 * binding that decides WHICH capability a call is judged against, the money
 * accounting the session cap depends on, and the single-use preview.
 *
 * The verifier itself is covered in the SDK. What matters here is that this
 * tool never reaches a wallet without a descriptor to check the call against,
 * that the descriptor comes from the JOB rather than from the caller, and that
 * an APPROVAL is counted at what it authorizes rather than the zero it moves.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assetKey,
  generateSolanaWallet,
  NATIVE_SOL,
  MAX_CALL_BASE64_CHARS,
  MAX_EXPLAIN_ENTRIES,
  MAX_EXPLAIN_TEXT_CHARS,
  ONCHAIN_DISCLAIMER,
  ONCHAIN_UNATTRIBUTED_NOTICE,
  USDC_SOLANA_DEVNET,
  DEFAULT_KIND_OFFSET,
  KIND_JOB_REQUEST_BASE,
  type OnchainCallFacts,
} from '@elisym/sdk';
import { getBase58Encoder } from '@solana/kit';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  type Event as NostrEvent,
} from 'nostr-tools';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentContext, type AgentInstance, type OnchainCallNonce } from '../src/context.js';
import { reserveSpend } from '../src/context.js';
import {
  appendCustomerJob,
  findCustomerJob,
  updateCustomerJob,
} from '../src/storage/customer-history.js';
import {
  assetForDelta,
  bounded,
  ceilingLine,
  previewText,
  previewTrailing,
  MAX_CALL_CHARS,
  clearsClaim,
  feeReservation,
  sessionCharges,
  grantedOf,
  headlineFor,
  parseCeiling,
  releaseAll,
  nativeOutflowOf,
  onchainTools,
  outflowOf,
  refusesUnattributed,
  settledOutcome,
  unattributedRefusal,
} from '../src/tools/onchain.js';

const PROVIDER_PUBKEY = 'a'.repeat(64);
const PROVIDER_NPUB = nip19.npubEncode(PROVIDER_PUBKEY);
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/**
 * The customer identity these tests speak as, and its job request - a REAL key
 * and a REAL signature.
 *
 * The tool verifies the job event before reading the provider and the
 * capability out of it, and those two decide which published promise a call is
 * judged against. A hand-built `{ id, pubkey, tags }` does not verify, so a
 * harness using one would exercise the binding by walking around the check
 * that guards it. The id is therefore the event's own hash rather than a
 * chosen constant.
 */
const CUSTOMER_SECRET_KEY = generateSecretKey();
const CUSTOMER_PUBKEY = getPublicKey(CUSTOMER_SECRET_KEY);

function signedRequest(secretKey: Uint8Array, tags: string[][]): NostrEvent {
  return finalizeEvent(
    {
      kind: KIND_JOB_REQUEST_BASE + DEFAULT_KIND_OFFSET,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: 'stub job input',
    },
    secretKey,
  );
}

const JOB_REQUEST = signedRequest(CUSTOMER_SECRET_KEY, [
  ['p', PROVIDER_PUBKEY],
  ['t', 'elisym'],
  ['t', 'withdraw'],
]);
const JOB_ID = JOB_REQUEST.id;

// Every case below is about what the tool does once the operator has enabled
// it. The gate itself is asserted in its own test.
const PRIOR_GATE = process.env.ELISYM_ALLOW_ONCHAIN_SIGNING;
beforeAll(() => {
  process.env.ELISYM_ALLOW_ONCHAIN_SIGNING = '1';
});
afterAll(() => {
  if (PRIOR_GATE === undefined) {
    delete process.env.ELISYM_ALLOW_ONCHAIN_SIGNING;
  } else {
    process.env.ELISYM_ALLOW_ONCHAIN_SIGNING = PRIOR_GATE;
  }
});

function tool() {
  const found = onchainTools.find((candidate) => candidate.name === 'sign_onchain_call');
  if (!found) {
    throw new Error('sign_onchain_call is not registered');
  }
  return found;
}

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

interface StubOptions {
  /** Agent storage dir, so the replay guard has a history file to read. */
  agentDir?: string;
  cards?: unknown[];
  /** The job request event this agent published, or null for "not on the relays". */
  request?: NostrEvent | null;
  /** The provider's delivered result content. */
  result?: string;
  /** A real keypair - `createKeyPairSignerFromBytes` rejects a zero-filled one. */
  walletSecretKey?: Uint8Array;
}

function stubAgent(options: StubOptions = {}): AgentInstance {
  const request = options.request === undefined ? JOB_REQUEST : options.request;
  return {
    client: {
      pool: { queryByIds: vi.fn(async () => (request ? [request] : [])) },
      discovery: {
        fetchAgent: vi.fn(async () => ({
          pubkey: PROVIDER_PUBKEY,
          npub: PROVIDER_NPUB,
          cards: options.cards ?? [],
        })),
      },
      marketplace: {
        queryJobResults: vi.fn(
          async () =>
            new Map([
              [
                JOB_ID,
                {
                  content: options.result ?? '{}',
                  senderPubkey: PROVIDER_PUBKEY,
                  decryptionFailed: false,
                },
              ],
            ]),
        ),
        reportCallSignature: vi.fn(),
      },
    } as never,
    identity: {
      publicKey: CUSTOMER_PUBKEY,
      npub: nip19.npubEncode(CUSTOMER_PUBKEY),
      secretKey: CUSTOMER_SECRET_KEY,
    } as never,
    name: 'stub',
    network: 'devnet',
    security: {},
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options.walletSecretKey
      ? { solanaKeypair: { publicKey: 'stub', secretKey: options.walletSecretKey } }
      : {}),
  };
}

function facts(overrides: Record<string, unknown> = {}) {
  return {
    programs: [],
    innerPrograms: [],
    instructionCount: 1,
    deltas: [],
    grants: [],
    unattributed: [],
    feeLamports: 5_000n,
    ...overrides,
  } as never;
}

async function preview(agent: AgentInstance, input: Record<string, unknown> = {}) {
  const ctx = new AgentContext();
  ctx.register(agent);
  return tool().handler(ctx, { job_id: JOB_ID, ...input } as never);
}

describe('sign_onchain_call - the job is the anchor', () => {
  it('needs a job id - the call is read from the job, never from the caller', async () => {
    const ctx = new AgentContext();
    ctx.register(stubAgent());
    const result = await tool().handler(ctx, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('needs job_id');
  });

  it('refuses a job that is not on the relays', async () => {
    const result = await preview(stubAgent({ request: null }));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('was not found');
  });

  it('refuses a job this agent did not submit', async () => {
    // Properly signed, by somebody else. The signature is not what refuses it -
    // the author is - so this stays a test of the ownership check rather than
    // sliding into the verification one below.
    const foreign = signedRequest(generateSecretKey(), [['p', PROVIDER_PUBKEY]]);
    const result = await preview(stubAgent({ request: foreign }), { job_id: foreign.id });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not submitted by this agent');
  });

  it('refuses a job event a relay handed back with a broken signature', async () => {
    // The provider and the capability are BOTH read out of this event, and they
    // decide which published promise the call is checked against. `nostr-tools`
    // verifies each frame today, so this is the guard for the day it does not -
    // it has an opt-out (`trustedRelayURLs`) one line from the check, and this
    // is the only path in the server that ends in a signature.
    // Round-tripped through JSON, the way an event actually arrives from a
    // relay. A spread would not do: `finalizeEvent` stamps the event with
    // `nostr-tools`' "verified" SYMBOL, `verifyEvent` short-circuits on it, and
    // object spread copies own symbol keys - so the tampered copy would verify
    // and this test would pass while asserting nothing.
    const tampered = JSON.parse(JSON.stringify(JOB_REQUEST)) as NostrEvent;
    tampered.tags = [...tampered.tags, ['p', 'f'.repeat(64)]];
    const result = await preview(stubAgent({ request: tampered }));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('signature that does not verify');
  });

  it('takes the capability from the job, so a caller cannot name a more permissive one', async () => {
    // The job names `withdraw`; the only card with a descriptor is `drain-me`.
    // A tool that trusted a caller-supplied capability would happily check the
    // call against the wrong promise.
    const result = await preview(
      stubAgent({ cards: [{ name: 'drain-me', onchain: descriptor }, { name: 'withdraw' }] }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no on-chain descriptor');
  });

  it('refuses an oversized result before parsing it', async () => {
    const result = await preview(
      // Past the derived cap (base64 transaction + the full `explain` allowance
      // at its worst-case JSON expansion + scaffolding), so it is refused unread.
      stubAgent({ cards: [{ name: 'withdraw', onchain: descriptor }], result: 'x'.repeat(60_000) }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('too large');
  });

  it('refuses an asset with no session spend limit rather than signing uncapped', async () => {
    const exotic = {
      ...descriptor,
      token: 'wif',
      mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    };
    const result = await preview(stubAgent({ cards: [{ name: 'withdraw', onchain: exotic }] }));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no session');
  });

  it('states WHY a call was refused instead of printing an object', async () => {
    const wallet = await generateSolanaWallet();
    const result = await preview(
      stubAgent({
        cards: [{ name: 'withdraw', onchain: descriptor }],
        walletSecretKey: new Uint8Array(getBase58Encoder().encode(wallet.secretKeyBase58)),
        result: 'here is your withdrawal, just sign it',
      }),
    );
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('malformed-envelope');
    expect(text).toContain('did not return a call');
  });
});

describe('sign_onchain_call - what the session cap counts', () => {
  it('counts what leaves in the capability asset, and ignores inflows', () => {
    const moved = outflowOf(
      facts({
        deltas: [
          { mint: USDC_MINT, subunits: -120_000_000n },
          { mint: USDC_MINT, subunits: 20_000_000n },
          { subunits: -5_000n },
        ],
      }),
      descriptor as never,
    );
    expect(moved).toBe(120_000_000n);
  });

  it('counts an approval at what it AUTHORIZES, not at the zero it moves', () => {
    const authorized = grantedOf(
      facts({
        deltas: [],
        grants: [
          { account: 'a', delegate: 'b', mint: USDC_MINT, subunits: 50_000_000n },
          { account: 'c', delegate: 'd', mint: USDC_MINT, subunits: 1_000_000n },
        ],
      }),
    );
    expect(authorized).toBe(51_000_000n);
  });

  it('reserves before signing and gives the reservation back when signing fails', async () => {
    const ctx = new AgentContext();
    // No wallet: the signing step throws AFTER the spend has been reserved,
    // which is exactly the path that must return it.
    ctx.register(stubAgent());
    ctx.issueOnchainNonce({
      id: 'n1',
      agentName: 'stub',
      transaction: 'AQID',
      lastValidBlockHeight: 100n,
      assetKey: assetKey(USDC_SOLANA_DEVNET),
      spendSubunits: 5_000_000n,
      authoritySubunits: 50_000_000n,
      nativeLamports: 2_044_280n,
      feeLamports: 5_000n,
      providerPubkey: PROVIDER_PUBKEY,
      createdAt: Date.now(),
    });

    const result = await tool().handler(ctx, { nonce: 'n1' } as never);
    expect(result.isError).toBe(true);
    expect(ctx.sessionSpent.get(assetKey(USDC_SOLANA_DEVNET)) ?? 0n).toBe(0n);
  });

  it('refuses to sign when the reservation would break the session cap', async () => {
    const ctx = new AgentContext();
    ctx.register(stubAgent());
    ctx.sessionSpendLimits.set(assetKey(USDC_SOLANA_DEVNET), 10_000_000n);
    ctx.issueOnchainNonce({
      id: 'n1',
      agentName: 'stub',
      transaction: 'AQID',
      lastValidBlockHeight: 100n,
      assetKey: assetKey(USDC_SOLANA_DEVNET),
      spendSubunits: 5_000_000n,
      authoritySubunits: 50_000_000n,
      nativeLamports: 2_044_280n,
      feeLamports: 5_000n,
      providerPubkey: PROVIDER_PUBKEY,
      createdAt: Date.now(),
    });

    const result = await tool().handler(ctx, { nonce: 'n1' } as never);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Session spend limit');
  });
});

describe('AgentContext on-chain nonces', () => {
  function nonce(overrides: Partial<OnchainCallNonce> = {}): OnchainCallNonce {
    return {
      id: 'n1',
      agentName: 'stub',
      transaction: 'AQID',
      lastValidBlockHeight: 100n,
      assetKey: assetKey(USDC_SOLANA_DEVNET),
      spendSubunits: 1n,
      authoritySubunits: 0n,
      nativeLamports: 0n,
      feeLamports: 5_000n,
      providerPubkey: PROVIDER_PUBKEY,
      createdAt: Date.now(),
      ...overrides,
    };
  }

  it('hands a preview back exactly once', () => {
    const ctx = new AgentContext();
    ctx.issueOnchainNonce(nonce());
    expect(ctx.consumeOnchainNonce('n1')?.transaction).toBe('AQID');
    expect(ctx.consumeOnchainNonce('n1')).toBeNull();
  });

  it('drops a preview older than the TTL', () => {
    const ctx = new AgentContext();
    ctx.issueOnchainNonce(nonce({ createdAt: Date.now() - AgentContext.NONCE_TTL_MS - 1 }));
    expect(ctx.consumeOnchainNonce('n1')).toBeNull();
  });

  it('bounds how many previews can be pending at once', () => {
    const ctx = new AgentContext();
    for (let index = 0; index < AgentContext.MAX_PENDING_NONCES; index += 1) {
      // Distinct jobs: one live preview PER JOB is the separate rule below.
      ctx.issueOnchainNonce(nonce({ id: `n${index}`, jobId: `job${index}` }));
    }
    expect(() => ctx.issueOnchainNonce(nonce({ id: 'overflow', jobId: 'jobX' }))).toThrow(
      /Too many pending/,
    );
  });

  it('refuses to sign a preview that belongs to another agent', async () => {
    const ctx = new AgentContext();
    ctx.register(stubAgent());
    ctx.issueOnchainNonce(nonce({ agentName: 'someone-else' }));
    const result = await tool().handler(ctx, { nonce: 'n1' } as never);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('belongs to agent');
  });

  it('refuses an unknown or expired nonce rather than signing something else', async () => {
    const ctx = new AgentContext();
    ctx.register(stubAgent());
    const result = await tool().handler(ctx, { nonce: 'not-a-real-nonce' } as never);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown or expired nonce');
  });
});

describe('sign_onchain_call - the operator gate', () => {
  it('refuses to sign anything until the operator turns it on', async () => {
    // Same posture as `approve_delegation`: a card with `grants_authority`
    // reaches the same end state as an approve, and here no human sits between
    // the LLM and the signature.
    const prior = process.env.ELISYM_ALLOW_ONCHAIN_SIGNING;
    delete process.env.ELISYM_ALLOW_ONCHAIN_SIGNING;
    try {
      const ctx = new AgentContext();
      ctx.register(stubAgent({ cards: [{ name: 'withdraw', onchain: descriptor }] }));
      const result = await tool().handler(ctx, { job_id: JOB_ID, kind_offset: 100 } as never);
      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toContain('ELISYM_ALLOW_ONCHAIN_SIGNING=1');
    } finally {
      if (prior !== undefined) {
        process.env.ELISYM_ALLOW_ONCHAIN_SIGNING = prior;
      }
    }
  });
});

describe('sign_onchain_call - what the SOL session cap must see', () => {
  it('counts the fee and any SOL rent of a token-denominated call', () => {
    // A `max_per_call: "0"` USDC capability whose call parks rent in a new
    // account moves no USDC at all; the lamports are still real spend from an
    // autonomous wallet and must be charged somewhere.
    const rent = 2_039_280n;
    const total = nativeOutflowOf(
      facts({ feeLamports: 5_000n, deltas: [{ subunits: -rent }] }) as never,
    );
    expect(total).toBe(rent + 5_000n);
  });

  it('ignores SOL arriving, so an inflow cannot pay for the fee', () => {
    expect(
      nativeOutflowOf(facts({ feeLamports: 5_000n, deltas: [{ subunits: 10n }] }) as never),
    ).toBe(5_000n);
  });
});

describe('sign_onchain_call - accounts outside the ceilings', () => {
  it('refuses by default, because nothing bounds what a call does to them', () => {
    expect(refusesUnattributed(['5rWZFsmzGkVpS8N7hBhKrnBEEbLKWUYUCiTeXPQVCVCv'], undefined)).toBe(
      true,
    );
    expect(refusesUnattributed(['5rWZFsmzGkVpS8N7hBhKrnBEEbLKWUYUCiTeXPQVCVCv'], false)).toBe(true);
  });

  it('stands aside once the caller accepts', () => {
    // The name this test used to carry - "takes only an explicit true" -
    // promised a distinction it could not make: the schema types the field
    // `boolean | undefined`, so `accepted !== true` and `!accepted` are the
    // same function and no input separates them. What is worth pinning is that
    // acceptance must be passed, which the `undefined` case above covers.
    expect(refusesUnattributed(['5rWZFsmzGkVpS8N7hBhKrnBEEbLKWUYUCiTeXPQVCVCv'], true)).toBe(false);
  });

  it('does not stand in the way of a call that writes to nothing unattributed', () => {
    expect(refusesUnattributed([], undefined)).toBe(false);
  });
});

describe('sign_onchain_call - both counters move together', () => {
  it('reserves the SOL fee and rent alongside the card asset, and gives both back', async () => {
    // A token-denominated card still spends real SOL on fee and account rent.
    // Reserving one and not the other would let a stream of such calls walk the
    // SOL cap with nothing counting them.
    const ctx = new AgentContext();
    ctx.register(stubAgent());
    ctx.issueOnchainNonce({
      id: 'n1',
      agentName: 'stub',
      transaction: 'AQID',
      lastValidBlockHeight: 100n,
      assetKey: assetKey(USDC_SOLANA_DEVNET),
      spendSubunits: 5_000_000n,
      authoritySubunits: 0n,
      nativeLamports: 2_044_280n,
      feeLamports: 5_000n,
      providerPubkey: PROVIDER_PUBKEY,
      createdAt: Date.now(),
    });

    // No wallet, so signing throws after both reservations were taken.
    const result = await tool().handler(ctx, { nonce: 'n1' } as never);
    expect(result.isError).toBe(true);
    expect(ctx.sessionSpent.get(assetKey(USDC_SOLANA_DEVNET)) ?? 0n).toBe(0n);
    expect(ctx.sessionSpent.get(assetKey(NATIVE_SOL)) ?? 0n).toBe(0n);
  });

  it('refuses, and reserves nothing at all, when the SOL cap alone is the blocker', async () => {
    // The card asset is affordable and the SOL is not: the first reservation
    // must be rolled back rather than left standing against a refused call.
    const ctx = new AgentContext();
    ctx.register(stubAgent());
    ctx.sessionSpendLimits.set(assetKey(NATIVE_SOL), 1_000n);
    ctx.issueOnchainNonce({
      id: 'n1',
      agentName: 'stub',
      transaction: 'AQID',
      lastValidBlockHeight: 100n,
      assetKey: assetKey(USDC_SOLANA_DEVNET),
      spendSubunits: 5_000_000n,
      authoritySubunits: 0n,
      nativeLamports: 2_044_280n,
      feeLamports: 5_000n,
      providerPubkey: PROVIDER_PUBKEY,
      createdAt: Date.now(),
    });

    const result = await tool().handler(ctx, { nonce: 'n1' } as never);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Session spend limit');
    expect(ctx.sessionSpent.get(assetKey(USDC_SOLANA_DEVNET)) ?? 0n).toBe(0n);
    expect(ctx.sessionSpent.get(assetKey(NATIVE_SOL)) ?? 0n).toBe(0n);
  });
});

describe('AgentContext - one live preview per job', () => {
  it('replaces an earlier preview of the same job instead of leaving both signable', () => {
    // Two previews of one job hold two DIFFERENT transactions - the verifier
    // re-simulates against a fresh blockhash - so both would land. Keeping only
    // the newest is what stops a caller confirming the same action twice.
    const ctx = new AgentContext();
    ctx.issueOnchainNonce(nonceFor('first', 'job-a'));
    ctx.issueOnchainNonce(nonceFor('second', 'job-a'));
    expect(ctx.consumeOnchainNonce('first')).toBeNull();
    expect(ctx.consumeOnchainNonce('second')).not.toBeNull();
  });

  it('leaves previews of OTHER jobs alone', () => {
    const ctx = new AgentContext();
    ctx.issueOnchainNonce(nonceFor('a', 'job-a'));
    ctx.issueOnchainNonce(nonceFor('b', 'job-b'));
    expect(ctx.consumeOnchainNonce('a')).not.toBeNull();
    expect(ctx.consumeOnchainNonce('b')).not.toBeNull();
  });
});

function nonceFor(id: string, jobId: string): OnchainCallNonce {
  return {
    id,
    agentName: 'stub',
    transaction: 'AQID',
    lastValidBlockHeight: 100n,
    assetKey: assetKey(USDC_SOLANA_DEVNET),
    spendSubunits: 1n,
    authoritySubunits: 0n,
    nativeLamports: 0n,
    feeLamports: 5_000n,
    providerPubkey: PROVIDER_PUBKEY,
    jobId,
    createdAt: Date.now(),
  };
}

describe('sign_onchain_call - what each send outcome is allowed to claim', () => {
  const SIG = '5'.repeat(64);

  it('claims confirmation only when the chain confirmed it', () => {
    expect(headlineFor('landed', SIG)).toContain('confirmed');
  });

  it('says "almost certainly landed" when the blockhash expired and absence could not be shown', () => {
    const line = headlineFor('assume-landed', SIG);
    expect(line).toContain('almost certainly landed');
    expect(line).not.toContain('confirmed:');
  });

  it('claims nothing about the chain for a send whose poll budget merely ran out', () => {
    // `unresolved` can mean every status call threw, so the blockhash may well
    // have expired. The honest statement is about what elisym knows, not about
    // what the chain did - and the advice must still be "do not send another".
    const line = headlineFor('unresolved', SIG);
    expect(line).toContain('could not establish');
    expect(line).toContain('Do not send another');
    expect(line).not.toContain('confirmed');
    expect(line).not.toContain('expired');
  });
});

describe('sign_onchain_call - a job whose call was already signed', () => {
  it('refuses a fresh preview instead of building a second landable call', async () => {
    // The envelope stays valid for up to 900s, so a second preview re-simulates
    // it against a new blockhash and yields a DIFFERENT transaction that lands
    // on its own. That is the same action executed twice.
    const agentDir = await mkdtemp(join(tmpdir(), 'elisym-onchain-'));
    try {
      await appendCustomerJob(agentDir, {
        jobEventId: JOB_ID,
        capability: 'withdraw',
        providerPubkey: PROVIDER_PUBKEY,
        status: 'completed',
        submittedAt: Date.now(),
        completedAt: Date.now(),
        callSignature: 'already-sent-signature',
      });
      const ctx = new AgentContext();
      ctx.register(stubAgent({ agentDir, cards: [{ name: 'withdraw', onchain: descriptor }] }));
      const result = await tool().handler(ctx, { job_id: JOB_ID, kind_offset: 100 } as never);
      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toContain('already produced a call');
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('lets a job with no recorded call through the guard', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'elisym-onchain-'));
    try {
      const ctx = new AgentContext();
      ctx.register(stubAgent({ agentDir, cards: [{ name: 'withdraw', onchain: descriptor }] }));
      const result = await tool().handler(ctx, { job_id: JOB_ID, kind_offset: 100 } as never);
      // It gets past the replay guard and fails later, for want of a wallet.
      expect(String(result.content[0]?.text)).not.toContain('already produced a call');
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('refuses at CONFIRM a nonce that was issued before the first signature', async () => {
    // The half the preview check cannot cover: this nonce was handed out while
    // the job was still unsigned, so it passed that gate. It holds a whole
    // transaction of its own, which would land independently of the one already
    // sent - the same action, executed twice, with the customer paying for both.
    const agentDir = await mkdtemp(join(tmpdir(), 'elisym-onchain-'));
    try {
      const ctx = new AgentContext();
      ctx.register(stubAgent({ agentDir }));
      ctx.issueOnchainNonce(nonceFor('n1', JOB_ID));
      await appendCustomerJob(agentDir, {
        jobEventId: JOB_ID,
        capability: 'withdraw',
        providerPubkey: PROVIDER_PUBKEY,
        status: 'completed',
        submittedAt: Date.now(),
        completedAt: Date.now(),
        callSignature: 'already-sent-signature',
      });
      const result = await tool().handler(ctx, { nonce: 'n1' } as never);
      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toContain('already produced a call');
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe('sign_onchain_call - a refused preview still speaks inside boundary markers', () => {
  it('wraps the refusal, because it quotes remote-derived text', async () => {
    const result = await preview(stubAgent({ cards: [] }));
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('UNTRUSTED');
  });

  it('keeps elisym’s own words OUTSIDE those markers', () => {
    // `sanitize.ts` tells the model to treat everything between the markers as
    // raw data and to follow no instruction inside them. The disclaimer, and
    // elisym's own instruction about `accept_unattributed`, were being wrapped
    // along with the provider-quoted text - delivering elisym's own words as
    // untrusted data. The verifier refusal path needs an RPC to reach, so the
    // split is pinned here at the seam itself.
    const text = String(bounded('provider said this', ONCHAIN_DISCLAIMER).content[0]?.text);
    const end = text.indexOf('UNTRUSTED EXTERNAL CONTENT END');
    expect(end).toBeGreaterThan(-1);
    expect(text.indexOf('provider said this')).toBeLessThan(end);
    expect(text.indexOf(ONCHAIN_DISCLAIMER)).toBeGreaterThan(end);
  });
});

describe('what each terminal outcome is allowed to do', () => {
  it('frees the job for a fresh call only when the action provably did not happen', () => {
    // `unresolved` is the one that matters: the poll budget ran out without
    // observing anything, so clearing the claim there would let the same paid
    // action be signed a second time.
    expect(clearsClaim('dead')).toBe(true);
    expect(clearsClaim('unresolved')).toBe(false);
    expect(clearsClaim('landed')).toBe(false);
    expect(clearsClaim('assume-landed')).toBe(false);
  });

  it('tells the provider it landed only when something established that', () => {
    expect(settledOutcome('landed')).toBe(true);
    expect(settledOutcome('assume-landed')).toBe(true);
    expect(settledOutcome('unresolved')).toBe(false);
    expect(settledOutcome('dead')).toBe(false);
  });
});

describe('previewText - the surface an LLM reads immediately before signing', () => {
  it('keeps the derived facts inside the markers and elisym’s words after them', () => {
    const text = previewText(
      ['What it does, as this client derived it:', '  -120 USDC'],
      [ONCHAIN_UNATTRIBUTED_NOTICE, '', ONCHAIN_DISCLAIMER, '', 'To sign and send it, call ...'],
    );
    const end = text.indexOf('UNTRUSTED EXTERNAL CONTENT END');
    expect(end).toBeGreaterThan(-1);
    expect(text.indexOf('-120 USDC')).toBeLessThan(end);
    // The disclaimer's own contract: in the primary flow, never a footnote,
    // and never delivered as data the model is told to ignore.
    expect(text.indexOf(ONCHAIN_DISCLAIMER)).toBeGreaterThan(end);
    expect(text.indexOf(ONCHAIN_UNATTRIBUTED_NOTICE)).toBeGreaterThan(end);
    expect(text).toContain('To sign and send it');
  });
});

describe('sign_onchain_call - the limiter the confirm step rides', () => {
  it('spends the withdraw budget, not only the generic tool budget', async () => {
    // Signing moves money, so the confirm step rides the same tight limiter as
    // `withdraw` (3 per 60s) rather than the generic per-tool budget. Nothing
    // asserted that: deleting the check survived the whole suite.
    const ctx = new AgentContext();
    ctx.register(stubAgent());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      ctx.withdrawRateLimiter.check();
    }
    const result = await tool().handler(ctx, { job_id: JOB_ID, nonce: 'no-such-nonce' } as never);
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('Rate limit exceeded');
  });

  it('leaves the preview step on the generic budget', async () => {
    // The preview reads and simulates; it signs nothing, so exhausting the
    // withdraw budget must not stop a customer looking at what they were sold.
    const ctx = new AgentContext();
    ctx.register(stubAgent({ request: null }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      ctx.withdrawRateLimiter.check();
    }
    const result = await tool().handler(ctx, { job_id: JOB_ID } as never);
    expect(String(result.content[0]?.text)).not.toContain('Rate limit exceeded');
  });
});

describe('previewTrailing - what elisym says in its own voice before signing', () => {
  const applied = {
    spendSubunits: 10_000_000n,
    authoritySubunits: 0n,
    incidentalLamports: 45_000_000n,
  };

  it('always carries the disclaimer, whatever else it says', () => {
    // Its own contract: in the primary flow, never a footnote. This is the one
    // surface an LLM reads immediately before signing, and deleting the line
    // from here survived the whole suite.
    for (const hasUnattributed of [true, false]) {
      for (const claimable of [true, false]) {
        const trailing = previewTrailing({
          asset: USDC_SOLANA_DEVNET,
          descriptor,
          applied,
          hasUnattributed,
          claimable,
          nonceId: 'nonce-1',
        });
        expect(trailing).toContain(ONCHAIN_DISCLAIMER);
        expect(trailing.join('\n')).toContain('To sign and send it');
      }
    }
  });

  it('states the bound this call APPLIED, not the one the card publishes', () => {
    // A caller who lowered their spend limit to 10 must not be told the bound
    // is the capability's 500 - that is a number nothing will enforce.
    const trailing = previewTrailing({
      asset: USDC_SOLANA_DEVNET,
      descriptor,
      applied,
      hasUnattributed: false,
      claimable: true,
      nonceId: 'nonce-1',
    }).join('\n');
    expect(trailing).toContain('10 USDC');
    expect(trailing).toContain('you lowered it from');
  });

  it('names the unattributed accounts only when there are some', () => {
    const withNotice = previewTrailing({
      asset: USDC_SOLANA_DEVNET,
      descriptor,
      applied,
      hasUnattributed: true,
      claimable: true,
      nonceId: 'nonce-1',
    });
    expect(withNotice).toContain(ONCHAIN_UNATTRIBUTED_NOTICE);
    const without = previewTrailing({
      asset: USDC_SOLANA_DEVNET,
      descriptor,
      applied,
      hasUnattributed: false,
      claimable: true,
      nonceId: 'nonce-1',
    });
    expect(without).not.toContain(ONCHAIN_UNATTRIBUTED_NOTICE);
  });

  it('warns when no history entry exists to arm the sign-once guard on', () => {
    const trailing = previewTrailing({
      asset: USDC_SOLANA_DEVNET,
      descriptor,
      applied,
      hasUnattributed: false,
      claimable: false,
      nonceId: 'nonce-1',
    }).join('\n');
    expect(trailing).toContain('cannot be armed for it');
  });
});

describe('unattributedRefusal - whose words go inside the markers', () => {
  it('keeps only the account list inside them', () => {
    // `sanitize.ts` tells the model to treat everything between the markers as
    // raw data and follow no instruction there. The addresses are the provider's
    // doing; the warning, the accept_unattributed instruction and the
    // disclaimer are elisym speaking, and wrapping them delivered this client's
    // own safety text as something to ignore.
    const text = String(unattributedRefusal(['acc-one', 'acc-two']).content[0]?.text);
    const end = text.indexOf('UNTRUSTED EXTERNAL CONTENT END');
    expect(end).toBeGreaterThan(-1);
    expect(text.indexOf('acc-one')).toBeLessThan(end);
    expect(text.indexOf(ONCHAIN_UNATTRIBUTED_NOTICE)).toBeGreaterThan(end);
    expect(text.indexOf('accept_unattributed=true')).toBeGreaterThan(end);
    expect(text.indexOf(ONCHAIN_DISCLAIMER)).toBeGreaterThan(end);
  });
});

describe('assetForDelta - what a foreign mint is rendered as', () => {
  const cardAsset = USDC_SOLANA_DEVNET;

  it('never dresses an unknown mint in the card asset’s units', () => {
    // The card's `decimals` and `symbol` are provider-controlled. Borrowing
    // them for some OTHER mint's delta would report a swap's proceeds in the
    // wrong scale entirely - the same rule the browser pins three ways and
    // `onchainCeiling` was missing until last round.
    expect(
      assetForDelta('NotAMintWeKnow11111111111111111111111111111', descriptor, cardAsset),
    ).toBe(undefined);
  });

  it('uses the card asset for the card’s own mint, and SOL for a native delta', () => {
    expect(assetForDelta(USDC_MINT, descriptor, cardAsset)).toBe(cardAsset);
    expect(assetForDelta(undefined, descriptor, cardAsset)).toBe(NATIVE_SOL);
  });
});

describe('ceilingLine - what the caller is told is bounded', () => {
  it('names the SOL allowance, which is the only bound over the fee', () => {
    // The fee rides `incidentalLamports` on EVERY card. Reporting only the
    // spend number would state a bound the verifier does not apply to it.
    const line = ceilingLine(USDC_SOLANA_DEVNET, descriptor, {
      spendSubunits: 500_000_000n,
      authoritySubunits: 0n,
      incidentalLamports: 45_000_000n,
    });
    expect(line).toContain('network fee, account rent and any other SOL it moves 0.045 SOL');
  });

  it('says whose number it is when the caller lowered one', () => {
    // The branch an LLM reads before confirming. Both existing cases used
    // ceilings equal to the card's, so nothing checked that the APPLIED number
    // is the one shown, nor that the capability's is named as the thing it was
    // lowered from.
    const line = ceilingLine(USDC_SOLANA_DEVNET, descriptor, {
      spendSubunits: 25_000_000n,
      authoritySubunits: 0n,
      incidentalLamports: 45_000_000n,
    });
    expect(line).toContain('spend 25 USDC (you lowered it from the 500 USDC');
  });

  it('does not promise a rent allowance a SOL-priced card does not have', () => {
    // A native card's RENT goes through the spend ceiling, so this allowance
    // holds the network fee alone and "and rent" would overstate it.
    const line = ceilingLine(
      NATIVE_SOL,
      { ...descriptor, mint: undefined, token: 'sol', decimals: 9, symbol: 'SOL' } as never,
      { spendSubunits: 0n, authoritySubunits: 0n, incidentalLamports: 45_000_000n },
    );
    expect(line).toContain('network fee 0.045 SOL');
    expect(line).not.toContain('rent');
  });
});

describe('what the preview will read before refusing it unread', () => {
  it('leaves room for the largest call the schema accepts, term by term', () => {
    // Asserted as the DERIVATION, not as inequalities. Two strict `>` checks
    // passed with the doubling removed entirely, which is the term the comment
    // says exists to survive JSON escaping of a base64 body.
    expect(MAX_CALL_CHARS).toBe(
      MAX_CALL_BASE64_CHARS * 2 + MAX_EXPLAIN_ENTRIES * 5 * MAX_EXPLAIN_TEXT_CHARS * 6 + 2_000,
    );

    // And the thing the derivation is FOR, built out of the characters that
    // actually EXPAND. An ASCII fixture measured 10,216 against a 53,288 cap -
    // so roomy that deleting BOTH multipliers still satisfied it. The real
    // worst case is a `/`-heavy base64 body (escaped in a JSON string) and a
    // non-ASCII `explain` (six chars per `\uXXXX`), which is what the `* 2`
    // and `* 6` in the formula are for.
    const worstCase = JSON.stringify({
      elisym_call: 'v1',
      network: 'devnet',
      transaction: '/'.repeat(MAX_CALL_BASE64_CHARS),
      signer: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      expires_at: 1_800_000_000,
      explain: Array.from({ length: MAX_EXPLAIN_ENTRIES }, () => ({
        kind: '\u0007'.repeat(MAX_EXPLAIN_TEXT_CHARS),
        asset: '\u0007'.repeat(MAX_EXPLAIN_TEXT_CHARS),
        amount: '\u0007'.repeat(MAX_EXPLAIN_TEXT_CHARS),
        to: '\u0007'.repeat(MAX_EXPLAIN_TEXT_CHARS),
        note: '\u0007'.repeat(MAX_EXPLAIN_TEXT_CHARS),
      })),
    });
    // Escaped exactly as a transport would: `/` doubles, `\u0007` sextuples.
    const escaped = worstCase.replace(/\//g, '\\/');
    expect(escaped.length).toBeLessThanOrEqual(MAX_CALL_CHARS);
    // And it is genuinely close to the cap, so the assertion discriminates.
    expect(escaped.length).toBeGreaterThan(MAX_CALL_CHARS / 2);
  });
});

describe('sessionCharges - the fee lands on exactly one counter', () => {
  const factsWith = (overrides: Partial<OnchainCallFacts> = {}): OnchainCallFacts => ({
    programs: [],
    innerPrograms: [],
    instructionCount: 1,
    deltas: [],
    grants: [],
    feeLamports: 5_000n,
    unitsConsumed: 5_000n,
    unattributed: [],
    ...overrides,
  });
  const nativeCard = { ...descriptor, mint: undefined, token: 'sol', decimals: 9, symbol: 'SOL' };

  it('charges a native card’s fee to its own ceiling, and nothing to the SOL cap', () => {
    // Rent is already a native delta, so it rides `outflowOf`; the fee is not,
    // because the verifier takes it back out of the deltas.
    const charges = sessionCharges(
      factsWith({ deltas: [{ subunits: -2_039_280n }] }),
      nativeCard as never,
    );
    expect(charges.spendSubunits).toBe(2_044_280n);
    expect(charges.nativeLamports).toBe(0n);
  });

  it('charges a token card’s fee to the SOL cap, and nothing to the token one', () => {
    const charges = sessionCharges(
      factsWith({
        deltas: [{ mint: USDC_MINT, subunits: -1_000_000n }, { subunits: -2_039_280n }],
      }),
      descriptor,
    );
    expect(charges.spendSubunits).toBe(1_000_000n);
    expect(charges.nativeLamports).toBe(2_044_280n);
  });

  it('still charges the fee when the call moves nothing at all', () => {
    // A `max_per_call: "0"` capability - claiming rewards, closing a position -
    // costs the customer exactly one fee, and the cap has to see it.
    const charges = sessionCharges(factsWith(), nativeCard as never);
    expect(charges.spendSubunits).toBe(5_000n);
  });
});

describe('feeReservation - the fee stays on the counter that paid it', () => {
  it('keeps the fee against SOL, whichever card it was', () => {
    // A token-denominated card reserves its SOL fee and rent separately, so the
    // fee is real lamports off the SOL cap even when the call reverted.
    expect(
      feeReservation({
        assetKey: assetKey(USDC_SOLANA_DEVNET),
        nativeLamports: 2_044_280n,
        feeLamports: 5_000n,
      }).get(assetKey(NATIVE_SOL)),
    ).toBe(5_000n);
    // A native card has no separate native reservation to keep it against.
    expect(
      feeReservation({
        assetKey: assetKey(NATIVE_SOL),
        nativeLamports: 0n,
        feeLamports: 5_000n,
      }).get(assetKey(NATIVE_SOL)),
    ).toBe(5_000n);
  });
});

describe('sign_onchain_call - a caller may lower a ceiling, never raise it', () => {
  it('clamps a requested ceiling to what the capability published', () => {
    expect(parseCeiling('900', USDC_SOLANA_DEVNET, 500_000_000n)).toBe(500_000_000n);
  });

  it('honours a lower one', () => {
    expect(parseCeiling('25', USDC_SOLANA_DEVNET, 500_000_000n)).toBe(25_000_000n);
  });

  it('reads an explicit zero as zero, not as "unset"', () => {
    expect(parseCeiling('0', USDC_SOLANA_DEVNET, 500_000_000n)).toBe(0n);
    expect(parseCeiling('0.00', USDC_SOLANA_DEVNET, 500_000_000n)).toBe(0n);
  });
});

describe('releaseAll - a reverted call still paid its fee', () => {
  it('keeps the fee on the counter and gives the rest back', () => {
    const ctx = new AgentContext();
    const reserved = [{ asset: NATIVE_SOL, amount: 1_000_000n }];
    reserveSpend(ctx, NATIVE_SOL, 1_000_000n);
    releaseAll(ctx, reserved, new Map([[assetKey(NATIVE_SOL), 5_000n]]));
    expect(ctx.sessionSpent.get(assetKey(NATIVE_SOL))).toBe(5_000n);
  });

  it('gives everything back when nothing was really spent', () => {
    const ctx = new AgentContext();
    const reserved = [{ asset: NATIVE_SOL, amount: 1_000_000n }];
    reserveSpend(ctx, NATIVE_SOL, 1_000_000n);
    releaseAll(ctx, reserved);
    expect(ctx.sessionSpent.get(assetKey(NATIVE_SOL)) ?? 0n).toBe(0n);
  });
});

describe('sign_onchain_call - a capability tag two cards answer to', () => {
  it('signs against the one card that could have built the call', async () => {
    // A provider's ordinary text capability may list the same keyword; only a
    // `mode: onchain` skill gets a descriptor, so there is no real ambiguity -
    // and refusing here would make every paid job of theirs unsignable.
    const result = await preview(
      stubAgent({
        cards: [
          { name: 'withdraw', onchain: descriptor },
          { name: 'notes', capabilities: ['withdraw'] },
        ],
      }),
    );
    expect(String(result.content[0]?.text)).not.toContain('cannot tell which promise');
  });

  it('refuses when the tag NAMES the card that published no descriptor', async () => {
    // The mirror of the case above. The tag names the plain text capability the
    // customer bought; a second card squats that name in its `capabilities`
    // list and carries a wide descriptor. Narrowing to descriptor-bearing cards
    // first would leave the squatter as the only answer, and the call would be
    // checked - and signed - against a promise from a capability nobody bought.
    const result = await preview(
      stubAgent({
        cards: [
          { name: 'withdraw' },
          { name: 'drain', capabilities: ['withdraw'], onchain: descriptor },
        ],
      }),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('publishes no on-chain descriptor');
  });

  it('still refuses when two cards each publish a descriptor for the tag', async () => {
    const result = await preview(
      stubAgent({
        cards: [
          { name: 'withdraw', onchain: descriptor },
          { name: 'other', capabilities: ['withdraw'], onchain: descriptor },
        ],
      }),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('cannot tell which promise');
  });
});

describe('sign_onchain_call - what the preview guard reads out of history', () => {
  it('leaves the entry in place with no signature on it', async () => {
    // What `clearCallInHistory` does on a `dead` outcome: `dead` is positive
    // proof nothing moved, so the job becomes signable again. (The confirm path
    // that calls it builds its own RPC client, so it is not reachable here.)
    const agentDir = await mkdtemp(join(tmpdir(), 'elisym-onchain-'));
    try {
      await appendCustomerJob(agentDir, {
        jobEventId: JOB_ID,
        capability: 'withdraw',
        providerPubkey: PROVIDER_PUBKEY,
        status: 'completed',
        submittedAt: Date.now(),
        completedAt: Date.now(),
        callSignature: 'claimed-then-dead',
      });
      await updateCustomerJob(agentDir, JOB_ID, { callSignature: undefined });
      const entry = await findCustomerJob(agentDir, JOB_ID);
      expect(entry).toBeDefined();
      expect(entry?.callSignature).toBeUndefined();
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it('keeps refusing while a claim is still standing in history', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'elisym-onchain-'));
    try {
      await appendCustomerJob(agentDir, {
        jobEventId: JOB_ID,
        capability: 'withdraw',
        providerPubkey: PROVIDER_PUBKEY,
        status: 'completed',
        submittedAt: Date.now(),
        completedAt: Date.now(),
      });
      await updateCustomerJob(agentDir, JOB_ID, { callSignature: 'in-flight' });
      const ctx = new AgentContext();
      ctx.register(stubAgent({ agentDir, cards: [{ name: 'withdraw', onchain: descriptor }] }));
      const result = await tool().handler(ctx, { job_id: JOB_ID, kind_offset: 100 } as never);
      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toContain('may have been broadcast');
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
