/**
 * Step four: the post-state assertion. This is what bounds the damage - and
 * it is worth being precise about which damage.
 *
 * Static decoding cannot see through CPI - a program can call
 * `Approve(u64::MAX)` from inside another program's instruction, moving no
 * value and matching no pattern a decoder would flag. The account state the
 * simulation leaves behind cannot be dodged that way: whatever route it took,
 * an approval is visible as a delegate on the account, a reassignment as a
 * changed owner, a drain as a balance that went down.
 *
 * Two ceilings, because a call can hurt in two different ways:
 * - what LEAVES now (the spend ceiling), and
 * - what someone else is authorized to move LATER (the authority ceiling).
 *
 * A zero delta is not safety. `Approve` moves nothing.
 *
 * **What the ceilings do NOT cover, and why the clients must say so.** Value is
 * attributed only to accounts this code can prove are the signer's: their
 * wallet account, and token accounts whose owner field is the signer. Funds a
 * PROGRAM holds for the signer - a lending obligation, a stake account, an
 * escrow - live in accounts owned by that program, and a withdrawal from one to
 * a stranger moves nothing the deltas can see. So every writable account the
 * verifier could not attribute is collected and reported, and a call that
 * carries any is never described as "nothing moves": the honest statement is
 * "nothing moves out of the accounts elisym can see, and here are the ones it
 * cannot".
 */

import { SYSTEM_PROGRAM_ADDRESS_STR } from './constants';
import { refuse } from './errors';
import type { OnchainDescriptor } from './schema';
import type { AccountSnapshot } from './simulate';
import { decodeTokenAccount, isTokenProgram, type TokenAccountState } from './token-account';
import type { OnchainAssetDelta, OnchainAuthorityGrant, OnchainCeilings } from './types';

/** Native SOL is keyed by this sentinel in the per-asset delta map. */
const NATIVE_KEY = 'sol';

/** The System program, which owns every plain wallet. */

export interface StateChange {
  deltas: OnchainAssetDelta[];
  grants: OnchainAuthorityGrant[];
  /**
   * Writable accounts the verifier could not attribute to the signer or to a
   * program it can reason about. The ceilings say nothing about what a call
   * does to these, which is exactly why they are surfaced.
   */
  unattributed: string[];
}

interface AnalyzeArgs {
  pre: Map<string, AccountSnapshot>;
  post: Map<string, AccountSnapshot>;
  signer: string;
  /** Accounts the transaction writes to. Read-only accounts cannot lose value. */
  writable: Set<string>;
  /**
   * What the network will charge the signer for this transaction, as computed
   * by `feeFor`. The simulation DOES charge it - it debits the fee payer before
   * execution and returns the debited account - so it is added back out of the
   * observed lamport delta here, leaving `deltas` describing the call alone.
   * The ceilings then bound the fee through `feeLamports`, exactly once.
   */
  feeLamports: bigint;
}

/**
 * Diff the signer's accounts. Refuses outright on the changes that have no
 * legitimate form - a reassigned authority or a close authority handed to
 * someone else - and returns the rest as numbers for the ceilings to judge.
 */
export function analyzeStateChange(args: AnalyzeArgs): StateChange {
  const { pre, post, signer, writable } = args;
  const byAsset = new Map<string, bigint>();
  const grants: OnchainAuthorityGrant[] = [];
  const unattributed: string[] = [];

  const signerPre = pre.get(signer);
  const signerPost = post.get(signer);
  if (signerPre?.exists && signerPost?.exists && signerPre.owner !== signerPost.owner) {
    refuse(
      'account-authority-changed',
      'the call hands your wallet account to another program - never signed',
    );
  }
  // Data on a fee-payer wallet is not a transfer, so no delta would show it -
  // and it is worse than one. A system account carrying data can no longer pay
  // a fee or send SOL, so the balance is stranded; allocate it to nonce size
  // and the caller can name themselves nonce authority and withdraw the lot.
  // `space` is the true pre length (the pre read is sliced, `space` is not) and
  // the post read is unsliced, so this compares like with like.
  if (signerPre?.exists && signerPost?.exists && signerPost.data.length > signerPre.space) {
    refuse(
      'account-authority-changed',
      'the call allocates data on your wallet account, which would stop it paying fees or ' +
        'sending SOL - never signed',
    );
  }
  if (signerPre && signerPost) {
    // The NETWORK FEE is added back, because the simulation already took it.
    //
    // `simulateTransaction` debits the fee payer before execution and returns
    // the debited account, so this difference carries the fee as well as the
    // call's own movement. Measured on live mainnet: two simulations of one
    // transfer at one slot, differing only by a 1.4M-CU limit at 5,000,000
    // microlamports/CU, came back exactly 7,000,000 lamports apart.
    //
    // Everything downstream reads `deltas` as what the CALL moves and takes the
    // fee from `feeLamports` instead - both ceilings, and both clients' "what
    // this call does" panels. Leaving the fee in here counted it twice, and on
    // a SOL-priced card the second copy landed in the spend ceiling, so
    // `max_per_call: "0"` - documented as legitimate for claiming rewards or
    // closing a position - refused every call it ever saw.
    addDelta(byAsset, NATIVE_KEY, signerPost.lamports - signerPre.lamports + args.feeLamports);
  }

  for (const [address, postAccount] of post) {
    if (address === signer) {
      continue;
    }
    const preAccount = pre.get(address);
    const preToken = tokenStateOf(preAccount);
    const postToken = tokenStateOf(postAccount);
    const wasOurs = preToken?.owner === signer;
    const isOurs = postToken?.owner === signer;
    if (!wasOurs && !isOurs) {
      if (writable.has(address) && !isSelfEvident(preAccount, postAccount, preToken, postToken)) {
        unattributed.push(address);
      }
      continue;
    }

    if (wasOurs && postToken && !isOurs) {
      refuse(
        'account-authority-changed',
        `the call transfers ownership of your token account ${address} to ${postToken.owner}`,
      );
    }
    if (wasOurs && !postToken && postAccount.exists && isTokenProgram(postAccount.owner)) {
      refuse(
        'post-state-unavailable',
        `the state of your token account ${address} after this call could not be read`,
      );
    }
    // A token account that existed and is ours must decode on BOTH sides. An
    // unreadable pre-state would silently read as a zero balance and turn an
    // outflow into an inflow - the one direction this diff must never fail in.
    if (isOurs && preAccount?.exists && isTokenProgram(preAccount.owner) && !preToken) {
      refuse(
        'post-state-unavailable',
        `the state of your token account ${address} before this call could not be read`,
      );
    }

    const preAmount = wasOurs ? (preToken?.amount ?? 0n) : 0n;
    const postAmount = isOurs ? (postToken?.amount ?? 0n) : 0n;
    const inflowContext = {
      postToken,
      wasOurs,
      existedBefore: preAccount?.exists === true,
      signer,
    };
    // Booked under each side's OWN mint, and each side's own native-ness. An
    // account closed and re-created at the same address - for a different mint,
    // or as wrapped SOL - would otherwise have one side erase the other: a
    // signer-owned USDC account emptied and re-made as a wSOL account is a real
    // outflow that a post-side-only native check would drop entirely.
    //
    // A wrapped-SOL account contributes nothing here on purpose: its `amount` is
    // a cached view of the lamports it already holds, which the lamport branch
    // below counts. Booking both would double it, and reporting the native mint
    // as a separate asset would make an honest unwrap read as an outflow of
    // something the card never published.
    const preMint = wasOurs && preToken?.isNative !== true ? preToken?.mint : undefined;
    const postMint = isOurs && postToken?.isNative !== true ? postToken?.mint : undefined;
    // A foreign CLOSE authority is not asked about here: the token program
    // refuses `CloseAccount` on a non-native account that still holds a
    // balance, so it can only ever take the lamports, which the branch below
    // accounts for separately.
    if (preMint !== undefined && preMint === postMint) {
      const change = postAmount - preAmount;
      if (change < 0n) {
        addDelta(byAsset, preMint, change);
      } else {
        addDelta(
          byAsset,
          preMint,
          inflowKept({
            ...inflowContext,
            arriving: change,
            held: preAmount,
            closeAuthorityReaches: false,
          }),
        );
      }
    } else {
      if (preMint !== undefined) {
        addDelta(byAsset, preMint, -preAmount);
      }
      if (postMint !== undefined) {
        addDelta(
          byAsset,
          postMint,
          // Nothing of THIS mint was held before: the pre-side, if any, was a
          // different one and has already been booked out in full above.
          inflowKept({
            ...inflowContext,
            arriving: postAmount,
            held: 0n,
            closeAuthorityReaches: false,
          }),
        );
      }
    }
    // The lamports sitting in a token account that was ALREADY the signer's are
    // theirs too: rent that a `CloseAccount` to a stranger walks off with, and
    // the balance of a wSOL account funded without a `SyncNative`. Neither
    // shows up in the token amount above.
    //
    // Strictly "was already ours", because lamports arriving in an account the
    // call CREATES must never offset the wallet they came from. Netting them
    // would let a capability drain the wallet into a fresh, correctly-owned
    // token account - rent scales with the space the call chooses, up to whole
    // SOL - and report `deltas: []`, i.e. "nothing moves", with no unattributed
    // account to warn about either. The lamports stay recoverable by closing
    // the account, but a ceiling that cannot see them is not a ceiling.
    //
    // Asymmetric on purpose. Lamports LEAVING such an account are always the
    // signer's loss, so a negative delta is always counted. Lamports ARRIVING
    // only offset the wallet they came from when the signer can actually get
    // them back out again - otherwise a call could park the wallet's balance
    // somewhere unreachable and report that nothing moved.
    if (wasOurs && preAccount && postAccount) {
      const lamportDelta = postAccount.lamports - preAccount.lamports;
      // Lamports additionally require wrapped SOL: for any other mint the
      // freeze authority belongs to its issuer, who may be the provider.
      if (lamportDelta < 0n) {
        addDelta(byAsset, NATIVE_KEY, lamportDelta);
      } else if (postToken?.isNative === true) {
        // Here a foreign close authority DOES reach the value: a native account
        // may be closed while it still holds one, which is how an unwrap works.
        addDelta(
          byAsset,
          NATIVE_KEY,
          // `held: 0n` here, not the account's pre-lamports: `delegatedAmount`
          // counts wrapped TOKEN units while these are the account's lamports,
          // rent included. Netting across the two would be arithmetic on
          // mismatched units, so this branch keeps charging the whole
          // allowance - the conservative direction.
          inflowKept({
            ...inflowContext,
            arriving: lamportDelta,
            held: 0n,
            closeAuthorityReaches: true,
          }),
        );
      }
    }

    if (isOurs && postToken) {
      // A confidential balance makes `amount` only the public half of what this
      // account holds, and the owner can move the hidden half into it with a
      // `ConfidentialTransfer::Withdraw`. That reads here as an inflow out of
      // nowhere, which can net a real outflow from another account to zero and
      // leave the diff reporting that nothing moved. The bound cannot describe
      // an account whose balance it cannot see, so it refuses instead.
      //
      // On the extension being PRESENT, not on it holding anything - the
      // ciphertexts are not readable, so "configured" is the strongest true
      // statement. Zero of 1,407 real mainnet Token-2022 accounts sampled carry
      // it, so this refuses nothing that exists today.
      if (postToken.hasConfidentialBalance) {
        refuse(
          'post-state-unavailable',
          `your token account ${address} is configured for confidential transfers, so its ` +
            'balance is not fully readable and the effect of this call cannot be bounded',
        );
      }
      assertNotNewlyFrozen(address, preToken, postToken);
      // The pre-state counts as "the same account" only when it was already the
      // signer's AND describes the same mint: after a close-and-re-create at
      // one address, a delegate carried over from the old mint is not evidence
      // that the new mint's approval was already standing.
      const comparable = wasOurs && preToken?.mint === postToken.mint ? preToken : null;
      assertCloseAuthorityUnchanged(address, signer, comparable, postToken);
      const grant = grantFrom(address, comparable, postToken, signer);
      if (grant) {
        grants.push(grant);
      }
    }
  }

  const deltas: OnchainAssetDelta[] = [];
  for (const [key, subunits] of byAsset) {
    if (subunits === 0n) {
      continue;
    }
    deltas.push(key === NATIVE_KEY ? { subunits } : { mint: key, subunits });
  }
  return { deltas, grants, unattributed };
}

/**
 * Accounts whose write cannot cost the signer anything: executables (a program
 * being called), and accounts that neither existed before nor after. Everything
 * else that is written and unattributed is reported.
 *
 * The executable arm is defence in depth, and deliberately unpinned: a program
 * that an instruction INVOKES cannot also be a writable meta of it, because kit
 * refuses to compile that shape and the rebuild would refuse it first. What is
 * left is an executable carried as a writable meta of some OTHER instruction,
 * which reaches here and would otherwise be reported as an unattributed write -
 * noise about an account the signer cannot lose anything to.
 */
function isSelfEvident(
  preAccount: AccountSnapshot | undefined,
  postAccount: AccountSnapshot,
  preToken: TokenAccountState | null,
  postToken: TokenAccountState | null,
): boolean {
  if (postAccount.executable) {
    return true;
  }
  // A token account where the ONLY thing that happened is that it received.
  //
  // The notice exists for state the bound cannot describe - a lending
  // obligation, a stake account, an escrow - where value may sit on the
  // signer's behalf in a shape this diff cannot read. A plain SPL token account
  // that merely gained is not that: every field is readable, it belongs to
  // someone who is not the signer, and the gain is what some delta above
  // already accounts for. Reporting those made the notice fire on a plain
  // transfer's recipient, which is noise on a warning that has to stay rare.
  //
  // EVERY OTHER FIELD MUST BE UNCHANGED, and that is the whole safety of this.
  // Exempting on `amount` alone silenced a standing `Approve(u64::MAX)` handed
  // to a stranger over a program-owned vault holding the customer's deposit -
  // reached by CPI, so the static gate never sees it, and `grantFrom` only runs
  // for accounts the signer owns. The verifier reported `grants: []` and
  // `unattributed: []` on a card publishing no authority at all, and MCP signs
  // that with no human in the loop. The same silence covered a new foreign
  // close authority, a freeze, and rent walked out of the account.
  //
  // A pre-state that is not a token account leaves every `preToken` field
  // `undefined`, so an account CREATED by the call, or an escrow record
  // reassigned into the token program, has to arrive with no delegate and no
  // close authority to qualify.
  // The same reasoning for a plain WALLET: system-owned, no data, and it only
  // gained lamports. A capability whose whole job is "send N SOL to X" was
  // otherwise refused by default in MCP, after payment, naming the destination
  // the customer themselves chose. Both sides must be a bare wallet, so a nonce
  // account - which is system-owned but carries data, and whose authority a
  // call can seize - is still reported.
  if (isBareWallet(preAccount) && isBareWallet(postAccount)) {
    return postAccount.lamports >= (preAccount?.lamports ?? 0n);
  }
  if (postToken === null || postToken.state !== 'initialized') {
    return false;
  }
  // The same account, and only then a comparison of its fields.
  //
  // Without this, an allowlisted program CPI-ing `SetAuthority(AccountOwner)`
  // on a vault holding the customer's deposit passed silently: every field
  // below was unchanged, the static gate sees no CPI, and the owner-change
  // refusal only runs for accounts that were already the signer's. That hands
  // over permanent, total control - strictly more than the `Approve` this arm
  // was tightened for last round. The mint check is the same rule the signer's
  // own booking applies a few lines up: comparing `amount` across a
  // close-and-recreate at one address compares two different assets.
  //
  // `preToken === null` alone is not enough: an account can fail to decode as a
  // token account because it WAS something else. A program that zeroes the
  // customer's obligation record, assigns it away and initializes a token
  // account at the same address would otherwise pass silently, and the
  // obligation is precisely the state this notice exists for. So the pre-state
  // must be absent, not merely unreadable.
  const sameAccount =
    (preToken === null && preAccount?.exists !== true) ||
    (preToken !== null && preToken.mint === postToken.mint && preToken.owner === postToken.owner);
  return (
    sameAccount &&
    postToken.amount >= (preToken?.amount ?? 0n) &&
    postAccount.lamports >= (preAccount?.lamports ?? 0n) &&
    postToken.delegate === preToken?.delegate &&
    postToken.delegatedAmount <= (preToken?.delegatedAmount ?? 0n) &&
    postToken.closeAuthority === preToken?.closeAuthority &&
    // `amount` is only the public half of a confidential account, so a
    // `ConfidentialTransfer` out of a vault moves nothing this can compare.
    // Not a pre/post comparison, because it cannot be one: the pre read is
    // sliced to the base layout, so the extension is never visible there. The
    // signer's own account is refused outright for the same reason.
    !postToken.hasConfidentialBalance
  );
}

/**
 * A plain wallet: owned by the System program and carrying no data. `space` is
 * the account's true length even under the pre-state's `dataSlice`, so both are
 * consulted - a data-bearing system account (a durable nonce) is not this.
 *
 * The two length clauses are redundant with each other on every shape a node
 * returns (`space` is the true length, and `data` is that length or a prefix of
 * it), so dropping either alone changes no verdict. Both are kept because they
 * answer different questions - what came back, and how big the account really
 * is - and a future read that slices differently would need them apart.
 */
function isBareWallet(account: AccountSnapshot | undefined): boolean {
  if (account === undefined || !account.exists) {
    return true;
  }
  return (
    account.owner === SYSTEM_PROGRAM_ADDRESS_STR && account.data.length === 0 && account.space === 0
  );
}

interface AssertArgs {
  change: StateChange;
  card: OnchainDescriptor;
  ceilings: OnchainCeilings;
  /** Fee the client will pay. Already taken back out of `change.deltas`. */
  feeLamports: bigint;
}

/** Apply both ceilings. Throws `OnchainRefusalError` on the first breach. */
export function assertCeilings(args: AssertArgs): void {
  const { change, card, ceilings, feeLamports } = args;
  const cardIsNative = card.mint === undefined;

  let incidentalLamports = feeLamports;
  for (const delta of change.deltas) {
    if (delta.subunits >= 0n) {
      continue;
    }
    const outflow = -delta.subunits;
    const isNative = delta.mint === undefined;
    if (isNative && cardIsNative) {
      assertSpend(outflow, ceilings.spendSubunits, card, 'SOL');
      continue;
    }
    if (isNative) {
      // SOL leaving a capability priced in something else is fee and the rent
      // of accounts the call creates or closes. It rides the incidental
      // allowance rather than the capability's own ceiling.
      incidentalLamports += outflow;
      continue;
    }
    if (delta.mint === card.mint) {
      assertSpend(outflow, ceilings.spendSubunits, card, card.symbol ?? card.token);
      continue;
    }
    refuse(
      'unexpected-asset-outflow',
      `the call moves ${outflow} subunits of ${delta.mint} out of your wallet, which is not the asset this capability published`,
    );
  }

  if (incidentalLamports > ceilings.incidentalLamports) {
    // What actually landed in this bucket differs by card. For a SOL-priced
    // capability every other lamport went to `assertSpend` above, so this is
    // the network fee alone; for one priced in a token it is the fee plus rent
    // plus any other SOL the call moved. Saying "priced in another asset" to a
    // SOL card, as this once did, is false of the only case it can mean.
    const what = cardIsNative
      ? 'the network fee'
      : 'network fee, account rent and any other SOL it moves';
    refuse(
      'fee-ceiling-exceeded',
      `this call takes ${incidentalLamports} lamports of SOL - ${what} - above the ${ceilings.incidentalLamports} you allowed`,
    );
  }

  if (change.grants.length > 0 && !card.grants_authority) {
    refuse(
      'authority-grant-not-declared',
      'the call leaves an approval on your account, which this capability never published',
    );
  }
  let granted = 0n;
  for (const grant of change.grants) {
    if (grant.mint !== card.mint) {
      refuse(
        'authority-grant-not-declared',
        `the call approves a delegate on ${grant.mint}, which is not the asset this capability published`,
      );
    }
    granted += grant.subunits;
  }
  if (granted > ceilings.authoritySubunits) {
    refuse(
      'authority-ceiling-exceeded',
      `the call authorizes ${granted} subunits to be moved later, above the ${ceilings.authoritySubunits} you allowed`,
    );
  }
}

function assertSpend(
  outflow: bigint,
  ceiling: bigint,
  card: OnchainDescriptor,
  label: string,
): void {
  if (outflow > ceiling) {
    refuse(
      'spend-ceiling-exceeded',
      `the call moves ${outflow} subunits of ${label} out of your wallet, above the ${ceiling} you allowed${
        outflow > BigInt(card.max_per_call_subunits)
          ? ' (and above what the capability itself published)'
          : ''
      }`,
    );
  }
}

function tokenStateOf(account: AccountSnapshot | undefined): TokenAccountState | null {
  if (!account?.exists || !isTokenProgram(account.owner)) {
    return null;
  }
  return decodeTokenAccount(account.data, { length: account.space, program: account.owner });
}

/**
 * How much of the value ARRIVING in this account really stays with the signer,
 * and may therefore offset an outflow elsewhere.
 *
 * Nothing does when:
 * - the account existed and was somebody else's, so its history is unknown;
 * - it no longer reads as a token account of theirs;
 * - it is FROZEN, so it can be neither emptied nor closed. A pre-existing
 *   freeze passes `assertNotNewlyFrozen`;
 * - a stranger holds a close authority that can reach this KIND of value.
 *   `assertCloseAuthorityUnchanged` deliberately lets a pre-existing one stand,
 *   so the caller says whether it bites: it does for lamports in a native
 *   account (closable while it still holds a balance - that is an unwrap), and
 *   it does not for a non-native token balance, which the token program refuses
 *   to close over.
 *
 * A standing delegate is the one exposure measured rather than assumed total.
 * It can move at most `delegatedAmount`, so that much of the arriving value is
 * withheld and the rest is credited. Voiding the whole inflow instead made a
 * transfer between two of the signer's OWN accounts read as a full outflow
 * whenever the destination carried any allowance at all - a false refusal after
 * the customer had paid, and one that elisym's own delegated-execution feature
 * leaves the state behind for.
 *
 * Applied to inflow only, never to the pre-side: an approval that moves nothing
 * must stay a zero delta, because it is bounded by the AUTHORITY ceiling rather
 * than the spend one. That asymmetry is the design, not an oversight.
 */
function inflowKept(args: {
  arriving: bigint;
  /**
   * How much of the SAME asset the account already held. A delegate that could
   * reach this much before the call reaches no further because of it, so only
   * the reach the call ADDS is charged to the call. Passed `0n` wherever the
   * two sides are not the same asset in the same units.
   */
  held: bigint;
  postToken: TokenAccountState | null;
  wasOurs: boolean;
  existedBefore: boolean;
  signer: string;
  closeAuthorityReaches: boolean;
}): bigint {
  const { arriving, held, postToken, wasOurs, existedBefore, signer, closeAuthorityReaches } = args;
  if (arriving <= 0n) {
    return 0n;
  }
  // An account that existed and was NOT the signer's arrives with a history
  // this diff cannot see. Whoever held it may have left a permanent delegate on
  // the mint, or may simply take it back; crediting its balance would let a
  // capability drain the signer and hand them a full account it still controls.
  // An account this call CREATED has no such history - everything done to it is
  // in the post-state.
  if (!wasOurs && existedBefore) {
    return 0n;
  }
  if (!postToken || postToken.state === 'frozen') {
    return 0n;
  }
  if (
    closeAuthorityReaches &&
    postToken.closeAuthority !== undefined &&
    postToken.closeAuthority !== signer
  ) {
    return 0n;
  }
  const delegated =
    postToken.delegate !== undefined && postToken.delegate !== signer
      ? postToken.delegatedAmount
      : 0n;
  // What the delegate can take AFTER this call, minus what it could already
  // have taken before it. Charging the whole allowance instead would still
  // refuse a call that moves nothing net, whenever the destination already
  // held at least the allowance - and `grantFrom` declines to report that same
  // pre-existing exposure as a grant, so booking it here contradicted it.
  const exposure = capped(delegated, held + arriving) - capped(delegated, held);
  return arriving - exposure;
}

/** `min` over bigints, named for what it is doing at the call site. */
function capped(value: bigint, ceiling: bigint): bigint {
  return value < ceiling ? value : ceiling;
}

/**
 * A call that leaves one of the signer's token accounts frozen has taken their
 * control of it away just as surely as a changed owner has - the balance is
 * intact and unusable until whoever holds the mint's freeze authority relents.
 * No value moves, so no ceiling would catch it; it is refused outright, in the
 * same family as an owner or close-authority change.
 */
function assertNotNewlyFrozen(
  address: string,
  preToken: TokenAccountState | null,
  postToken: TokenAccountState,
): void {
  if (postToken.state !== 'frozen' || preToken?.state === 'frozen') {
    return;
  }
  refuse('account-authority-changed', `the call freezes your token account ${address}`);
}

function assertCloseAuthorityUnchanged(
  address: string,
  signer: string,
  preToken: TokenAccountState | null,
  postToken: TokenAccountState,
): void {
  const authority = postToken.closeAuthority;
  if (authority === undefined || authority === signer) {
    return;
  }
  if (preToken?.closeAuthority === authority) {
    return;
  }
  refuse(
    'account-authority-changed',
    `the call lets ${authority} close your token account ${address}`,
  );
}

function grantFrom(
  address: string,
  preToken: TokenAccountState | null,
  postToken: TokenAccountState,
  signer: string,
): OnchainAuthorityGrant | null {
  const delegate = postToken.delegate;
  // A delegate that IS the signer hands nobody anything - they could already
  // move their own balance. `inflowKept` reads it that way, and reporting it as
  // a grant here made the two disagree: a call that approves the customer as
  // their own delegate was refused `authority-grant-not-declared` on a card
  // that never needed to declare one.
  if (delegate === undefined || delegate === signer || postToken.delegatedAmount === 0n) {
    return null;
  }
  const unchanged =
    preToken?.delegate === delegate && preToken.delegatedAmount >= postToken.delegatedAmount;
  if (unchanged) {
    return null;
  }
  return {
    account: address,
    delegate,
    mint: postToken.mint,
    subunits: postToken.delegatedAmount,
  };
}

function addDelta(byAsset: Map<string, bigint>, key: string, delta: bigint): void {
  byAsset.set(key, (byAsset.get(key) ?? 0n) + delta);
}
