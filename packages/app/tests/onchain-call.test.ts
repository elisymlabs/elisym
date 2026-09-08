/**
 * The pure half of the confirm sheet: turning verifier facts into rows a person
 * can judge, and deciding when a job result is a call at all.
 *
 * The verifier itself is covered in the SDK. What matters here is that the view
 * never invents precision it does not have and never quietly hides a program it
 * cannot name.
 */

import {
  USDC_SOLANA_DEVNET,
  type CapabilityCard,
  type OnchainCallFacts,
  type OnchainDescriptor,
} from '@elisym/sdk';
import { SendTransactionError } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  blockingCallSignature,
  keptCallStatus,
  ceilingLabel,
  descriptorAsset,
  narrowedCeiling,
  seedLimit,
  sendFailureDetail,
  hasUnknownProgram,
  isCallEnvelope,
  looksLikeCall,
  onchainCardFor,
  programLabel,
  refusalHeadline,
  sanitizeAmountInput,
  toCallView,
  wasBroadcast,
} from '~/lib/onchainCall';

const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const KAMINO = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';

const descriptor: OnchainDescriptor = {
  network: 'devnet',
  kind: 'withdraw',
  programs: [TOKEN_PROGRAM, KAMINO],
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

function facts(overrides: Partial<OnchainCallFacts> = {}): OnchainCallFacts {
  return {
    programs: [TOKEN_PROGRAM],
    innerPrograms: [],
    instructionCount: 1,
    deltas: [],
    grants: [],
    unattributed: [],
    feeLamports: 5_000n,
    ...overrides,
  };
}

describe('toCallView', () => {
  it('renders the capability asset in display units, with direction', () => {
    const view = toCallView(
      facts({ deltas: [{ mint: USDC_MINT, subunits: -120_000_000n }] }),
      descriptor,
    );
    expect(view.movements).toEqual([
      { direction: '-', amount: '120', symbol: 'USDC', isCardAsset: true },
    ]);
    expect(view.movesNothing).toBe(false);
  });

  it('renders native SOL rent and fee as SOL, not as the card asset', () => {
    const view = toCallView(facts({ deltas: [{ subunits: -2_039_280n }] }), descriptor);
    expect(view.movements[0]?.symbol).toBe('SOL');
    expect(view.movements[0]?.isCardAsset).toBe(false);
  });

  it('shows an unknown mint in subunits rather than inventing decimals', () => {
    const view = toCallView(
      facts({ deltas: [{ mint: 'So11111111111111111111111111111111111111112', subunits: -7n }] }),
      descriptor,
    );
    expect(view.movements[0]?.amount).toBe('7 subunits');
  });

  it('says plainly when nothing moves - an approve-only call', () => {
    const view = toCallView(facts(), descriptor);
    expect(view.movesNothing).toBe(true);
  });

  it('carries through the accounts the ceilings do not cover', () => {
    // A lending position lives in an account the program owns, so a withdrawal
    // from it to a stranger shows up in no delta. The sheet has to say so.
    const view = toCallView(
      facts({ unattributed: ['5rWZFsmzGkVpS8N7hBhKrnBEEbLKWUYUCiTeXPQVCVCv'] }),
      descriptor,
    );
    expect(view.movesNothing).toBe(true);
    expect(view.unattributed).toEqual(['5rWZFsmzGkVpS8N7hBhKrnBEEbLKWUYUCiTeXPQVCVCv']);
  });

  it('spells out a standing approval, with who gets it and for how much', () => {
    const view = toCallView(
      facts({
        grants: [{ account: 'ata', delegate: 'spender', mint: USDC_MINT, subunits: 50_000_000n }],
      }),
      descriptor,
    );
    expect(view.grants).toEqual([
      { account: 'ata', delegate: 'spender', amount: '50', symbol: 'USDC' },
    ]);
  });

  it('compacts a tiny fee instead of truncating it', () => {
    const view = toCallView(facts({ feeLamports: 5_200n }), descriptor);
    expect(view.fee).toBe('0.0₄52');
  });
});

describe('program naming', () => {
  it('names the programs a customer sees constantly', () => {
    expect(programLabel(TOKEN_PROGRAM)).toBe('SPL Token');
    expect(programLabel('11111111111111111111111111111111')).toBe('System');
  });

  it('calls anything else an unknown program rather than dressing it up', () => {
    expect(programLabel(KAMINO)).toBe('unknown program');
  });

  it('flags a call that reaches an unnamed program, top level or inside a CPI', () => {
    expect(hasUnknownProgram(toCallView(facts({ programs: [TOKEN_PROGRAM] }), descriptor))).toBe(
      false,
    );
    expect(
      hasUnknownProgram(toCallView(facts({ programs: [TOKEN_PROGRAM, KAMINO] }), descriptor)),
    ).toBe(true);
    expect(hasUnknownProgram(toCallView(facts({ innerPrograms: [KAMINO] }), descriptor))).toBe(
      true,
    );
  });
});

describe('looksLikeCall', () => {
  it('recognises a call envelope', () => {
    expect(looksLikeCall('{"elisym_call":"v1","network":"devnet"}')).toBe(true);
    expect(looksLikeCall('   {"elisym_call":"v1"}')).toBe(true);
  });

  it('leaves ordinary results alone', () => {
    expect(looksLikeCall('Here is your answer.')).toBe(false);
    expect(looksLikeCall('{"result":"some json but not a call"}')).toBe(false);
    expect(looksLikeCall(undefined)).toBe(false);
  });
});

describe('refusalHeadline', () => {
  it('uses the same words as the MCP client', () => {
    expect(refusalHeadline('durable-nonce-lifetime')).toBe('This call never expires once signed.');
    expect(refusalHeadline('program-not-on-card')).toContain('never published');
  });
});

describe('descriptorAsset', () => {
  it('resolves a known asset from the registry', () => {
    expect(descriptorAsset(descriptor)?.symbol).toBe('USDC');
  });

  it('refuses to take decimals from the card for an asset this build does not know', () => {
    // The card is provider-controlled: a declared 9 decimals over a 6-decimal
    // mint would render a 500-token outflow as "0.5" in the sheet a human
    // approves. Unknown asset means no asset, and amounts fall back to subunits.
    expect(
      descriptorAsset({
        ...descriptor,
        token: 'wif',
        mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
        decimals: 9,
        symbol: 'WIF',
      }),
    ).toBeNull();
  });

  it('shows the card asset in subunits when its mint is unknown', () => {
    const unknownCard = {
      ...descriptor,
      token: 'wif',
      mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
      decimals: 9,
      symbol: 'WIF',
    };
    const view = toCallView(
      facts({ deltas: [{ mint: unknownCard.mint, subunits: -500_000_000n }] }),
      unknownCard,
    );
    expect(view.movements[0]?.amount).toBe('500000000 subunits');
  });
});

describe('sanitizeAmountInput', () => {
  it('drops everything that is not a digit or the first decimal point', () => {
    expect(sanitizeAmountInput('1,5', 6)).toBe('15');
    expect(sanitizeAmountInput('12abc.34', 6)).toBe('12.34');
    expect(sanitizeAmountInput('1.2.3', 6)).toBe('1.23');
  });

  it('truncates the fraction to the asset decimals, never rounding up', () => {
    expect(sanitizeAmountInput('1.9999999', 6)).toBe('1.999999');
    expect(sanitizeAmountInput('0.5', 0)).toBe('0');
  });

  it('leaves an empty box empty rather than inventing a number', () => {
    expect(sanitizeAmountInput('', 6)).toBe('');
    expect(sanitizeAmountInput('abc', 6)).toBe('');
  });
});

describe('ceilingLabel', () => {
  it('names the asset when this build knows it', () => {
    expect(ceilingLabel(500_000_000n, USDC_SOLANA_DEVNET)).toBe('500 USDC');
  });

  it('falls back to subunits rather than guessing decimals', () => {
    expect(ceilingLabel(500_000_000n, null)).toBe('500000000 subunits');
  });
});

describe('toCallView on a partial facts object', () => {
  it('renders what a REFUSED call was found to move, without inventing the rest', () => {
    // The verifier attaches whatever it derived before refusing, so a customer
    // told "this moves more than you allowed" can see what it moves.
    const view = toCallView({ deltas: [{ mint: USDC_MINT, subunits: -600_000_000n }] }, descriptor);
    expect(view.movements).toEqual([
      { direction: '-', amount: '600', symbol: 'USDC', isCardAsset: true },
    ]);
    expect(view.programs).toEqual([]);
    expect(view.fee).toBe('0');
    expect(view.unattributed).toEqual([]);
  });
});

describe('blockingCallSignature', () => {
  it('blocks a call that landed, and one still awaiting a verdict', () => {
    expect(blockingCallSignature({ callSignature: 'sig', callStatus: 'landed' })).toBe('sig');
    expect(blockingCallSignature({ callSignature: 'sig', callStatus: 'sent' })).toBe('sig');
  });

  it('does NOT block after a call the chain rejected - nothing moved, so a retry is legitimate', () => {
    expect(blockingCallSignature({ callSignature: 'sig', callStatus: 'failed' })).toBeUndefined();
  });

  it('does not block a job that never produced a call', () => {
    expect(blockingCallSignature({})).toBeUndefined();
    expect(blockingCallSignature({ callStatus: 'sent' })).toBeUndefined();
  });
});

describe('narrowedCeiling', () => {
  const USDC = USDC_SOLANA_DEVNET;

  it('clamps a requested ceiling to what the capability published', () => {
    expect(narrowedCeiling('900', USDC, 500_000_000n, 'spend')).toBe(500_000_000n);
  });

  it('honours a lower one', () => {
    expect(narrowedCeiling('25', USDC, 500_000_000n, 'spend')).toBe(25_000_000n);
  });

  it('reads an explicit zero as zero, not as "unset"', () => {
    expect(narrowedCeiling('0', USDC, 500_000_000n, 'spend')).toBe(0n);
    expect(narrowedCeiling('0.00', USDC, 500_000_000n, 'spend')).toBe(0n);
  });

  it('refuses an empty box rather than reading it as the published maximum', () => {
    expect(() => narrowedCeiling('   ', USDC, 500_000_000n, 'spend')).toThrow(/Enter a spend/);
  });

  it('takes an unknown asset in whole subunits only', () => {
    expect(narrowedCeiling('42', null, 500n, 'spend')).toBe(42n);
    expect(() => narrowedCeiling('4.2', null, 500n, 'spend')).toThrow(/subunits/);
  });
});

describe('seedLimit', () => {
  it('shows the published ceiling in display units', () => {
    expect(seedLimit(500_000_000n, USDC_SOLANA_DEVNET)).toBe('500');
  });

  it('clamps a ceiling the amount parser could never take back', () => {
    // Only ever LOWERS, so the box can never seed a number above the published
    // one - and the customer's first click is not an error on a figure the app
    // typed for them.
    const seeded = seedLimit(10n ** 30n, USDC_SOLANA_DEVNET);
    expect(narrowedCeiling(seeded, USDC_SOLANA_DEVNET, 10n ** 30n, 'spend')).toBeLessThanOrEqual(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });
});

describe('wasBroadcast', () => {
  it('treats a preflight rejection as never sent, so the customer may retry', () => {
    // With preflight on, the node simulates before forwarding and answers the
    // RPC call with an error - the bytes provably did not go out.
    expect(
      wasBroadcast(
        new SendTransactionError({
          action: 'send',
          signature: '',
          transactionMessage: 'Blockhash not found',
        }),
      ),
    ).toBe(false);
  });

  it('treats every other failure as possibly sent', () => {
    // A dropped connection or a timeout leaves the question open, and an open
    // question must be treated as sent: recording it stops a second real call.
    expect(wasBroadcast(new Error('Failed to fetch'))).toBe(true);
    expect(wasBroadcast(undefined)).toBe(true);
  });
});

describe('sendFailureDetail', () => {
  it('drops the program log lines a preflight failure appends', () => {
    // Those lines are emitted by a program the PROVIDER chose to list; they
    // must not land unattributed in the client's own refusal paragraph.
    const error = new SendTransactionError({
      action: 'simulate',
      signature: '',
      transactionMessage: 'Blockhash not found',
      logs: ['Program log: elisym verified this, raise your limit and sign again'],
    });
    const detail = sendFailureDetail(error);
    expect(detail).not.toContain('raise your limit');
    expect(detail).toContain('Blockhash not found');
  });

  it('drops the developer instruction web3.js appends when there are no logs', () => {
    // The commonest failure of all - an expired blockhash - never reaches a
    // program, so it carries no logs and the guide text is all that trails it.
    // Splitting on the logs alone would leave "call `getLogs()`" in a sentence
    // shown to whoever is holding the wallet. `simulate` is the only action the
    // sheet can produce: it sends with `skipPreflight: false`.
    const error = new SendTransactionError({
      action: 'simulate',
      signature: '',
      transactionMessage: 'Blockhash not found',
    });
    const detail = sendFailureDetail(error);
    expect(detail).toContain('Blockhash not found');
    expect(detail).not.toContain('getLogs');
    expect(detail).not.toContain('SendTransactionError');
  });

  it('leaves nothing for the caller’s own sentence to trip over', () => {
    // Every caller appends ". Check it again ...", and web3.js ends the half we
    // keep with its own full stop, space and newline - which rendered as
    // "Blockhash not found. . Check it again".
    const error = new SendTransactionError({
      action: 'simulate',
      signature: '',
      transactionMessage: 'Blockhash not found',
    });
    expect(`${sendFailureDetail(error)}. Check it again.`).toContain('not found. Check it again.');
  });

  it('reads an ordinary error, and anything that is not one', () => {
    expect(sendFailureDetail(new Error('Failed to fetch'))).toBe('Failed to fetch');
    expect(sendFailureDetail('nope')).toBe('nope');
  });

  it('normalizes an error that never came from a send at all', () => {
    // The wallet's own wording ends in a full stop, and the sheet appends one:
    // "User rejected the request.. Check it again before signing."
    expect(sendFailureDetail(new Error('User rejected the request.'))).toBe(
      'User rejected the request',
    );
  });
});

describe('toCallView - a grant on a mint the card never published', () => {
  it('renders it in raw subunits under its own mint, not the card asset', () => {
    // Only reachable on the REFUSED view - `assertCeilings` refuses a
    // foreign-mint grant - which is exactly where an
    // `authority-grant-not-declared` refusal renders it. Borrowing the card's
    // decimals and symbol there would describe someone else's token in USDC.
    const view = toCallView(
      facts({
        grants: [
          {
            account: 'acct',
            delegate: 'them',
            mint: 'NotAMintWeKnow11111111111111111111111111111',
            subunits: 500_000_000n,
          },
        ],
      }),
      descriptor,
    );
    expect(view.grants[0]?.symbol).toBe('NotAMintWeKnow11111111111111111111111111111');
    expect(view.grants[0]?.amount).toBe('500000000 subunits');
  });
});

describe('isCallEnvelope - a result that merely mentions a call is not one', () => {
  it('accepts a real envelope and rejects an answer that talks about one', () => {
    const real = JSON.stringify({
      elisym_call: 'v1',
      network: 'devnet',
      transaction: 'AQAB',
      signer: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    expect(isCallEnvelope(real)).toBe(true);
    // A docs or support capability answering a question ABOUT the envelope
    // satisfies the substring gate. Swapping its answer for a notice about
    // calls would be a false statement about what the agent said.
    // Must satisfy the cheap gate, or the parse is never reached and this
    // asserts nothing: the previous fixture escaped its quotes, so the literal
    // `"elisym_call"` was not a substring and `looksLikeCall` alone rejected it.
    const mentionsOne = '{"field":"elisym_call","version":"v1"}';
    expect(looksLikeCall(mentionsOne)).toBe(true);
    expect(isCallEnvelope(mentionsOne)).toBe(false);
    expect(isCallEnvelope(undefined)).toBe(false);
  });
});

describe('keptCallStatus - a stored claim taking the screen back', () => {
  it('does not lower this flow’s own failed verdict to a stale stored `sent`', () => {
    // The `failed` write can fail to commit, leaving the store saying `sent`
    // for a call this client watched revert. Re-reading it would put "could
    // not confirm whether it landed - if the explorer has no such transaction
    // it never went out" in the same panel as "it failed on-chain, buy the
    // capability again". The first sentence is false, and following it means
    // making a second real call.
    expect(keptCallStatus('sig-1', 'sent', { signature: 'sig-1', status: 'failed' })).toBe(
      'failed',
    );
    expect(keptCallStatus('sig-1', 'sent', { signature: 'sig-1', status: 'landed' })).toBe(
      'landed',
    );
  });

  it('takes the stored verdict for a signature this flow never reached', () => {
    // Another tab's call, or one recovered from another device. This flow has
    // nothing to say about it, so the store decides.
    expect(keptCallStatus('other', 'sent', { signature: 'sig-1', status: 'failed' })).toBe('sent');
    expect(keptCallStatus('other', 'landed', { signature: null, status: null })).toBe('landed');
  });

  it('never keeps a local `sent`, which is not a verdict', () => {
    // A stored `landed` or `failed` may be newer than this tab's `sent`.
    expect(keptCallStatus('sig-1', 'landed', { signature: 'sig-1', status: 'sent' })).toBe(
      'landed',
    );
    expect(keptCallStatus('sig-1', undefined, { signature: 'sig-1', status: 'sent' })).toBe('sent');
  });
});

describe('onchainCardFor - which published promise a paid call is checked against', () => {
  const cardOf = (
    name: string,
    options: { capabilities?: string[]; onchain?: OnchainDescriptor } = {},
  ): CapabilityCard => ({
    name,
    description: 'a capability',
    capabilities: options.capabilities ?? [],
    ...(options.onchain ? { onchain: options.onchain } : {}),
  });

  it('matches a card by its own name', () => {
    const cards = [cardOf('Withdraw', { onchain: descriptor })];
    expect(onchainCardFor(cards, 'withdraw')?.name).toBe('Withdraw');
  });

  it('matches a card by a capability keyword, not only by its name', () => {
    // A job's capability tag carries whatever the customer bought it under.
    // Matching on the name alone would leave a paid call with no sheet to sign
    // it in - the customer pays and gets a plain text result they cannot use.
    const cards = [cardOf('Kamino helper', { capabilities: ['withdraw'], onchain: descriptor })];
    expect(onchainCardFor(cards, 'withdraw')?.name).toBe('Kamino helper');
  });

  it('ignores a card that published no on-chain promise', () => {
    // Only a `mode: onchain` skill gets a descriptor, so a plain text
    // capability answering to the same keyword is not real ambiguity.
    // The decoy must answer to the SAME tag, or the narrowing is never
    // exercised: `toDTag('Withdraw notes')` is `withdraw-notes`, which never
    // matched `withdraw` in the first place. Refusing this pair as ambiguous
    // would make every paid on-chain job of such a provider unsignable.
    const cards = [
      cardOf('Withdraw notes', { capabilities: ['withdraw'] }),
      cardOf('Withdraw', { onchain: descriptor }),
    ];
    expect(onchainCardFor(cards, 'withdraw')?.name).toBe('Withdraw');
  });

  it('refuses when two published promises answer to one tag', () => {
    // The tag does not say which was bought, and the two may carry different
    // ceilings. Picking the first could check the call against a promise wider
    // than the one the customer paid for, so there is no sheet at all.
    const cards = [
      cardOf('Withdraw', { onchain: descriptor }),
      cardOf('Other', { capabilities: ['withdraw'], onchain: descriptor }),
    ];
    expect(onchainCardFor(cards, 'withdraw')).toBeUndefined();
  });

  it('refuses when the tag NAMES a card that published no promise', () => {
    // The mirror of the case above, and the one the customer actually walks
    // into. The buy path writes the selected card's own name as the tag, so a
    // tag equal to a card's name is that card. A second card whose
    // `capabilities` list squats that name while carrying a wide descriptor
    // would otherwise be the only promise answering, and the sheet would bind
    // the call to a ceiling the customer never looked at, from a capability
    // they never bought.
    const cards = [
      cardOf('Summarize text'),
      cardOf('Drain', { capabilities: ['Summarize text'], onchain: descriptor }),
    ];
    expect(onchainCardFor(cards, 'summarize-text')).toBeUndefined();
  });

  it('does not throw on a keyword that cannot be a tag', () => {
    // `toDTag` throws on any string with no ASCII alphanumeric in it, and a
    // card's `capabilities` entries are provider-controlled and validated only
    // for type and length. This runs inside the chat's entry map during render,
    // so the throw took down the whole thread for anyone opening that agent.
    const cards = [
      cardOf('Hostile', { capabilities: ['-', '', ' '] }),
      cardOf('Withdraw', { onchain: descriptor }),
    ];
    expect(() => onchainCardFor(cards, 'withdraw')).not.toThrow();
    expect(onchainCardFor(cards, 'withdraw')?.name).toBe('Withdraw');
  });

  it('has nothing to offer when no card matches', () => {
    expect(onchainCardFor([cardOf('Withdraw', { onchain: descriptor })], 'swap')).toBeUndefined();
  });
});
