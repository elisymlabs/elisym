import {
  defaultCeilings,
  NATIVE_SOL,
  ONCHAIN_DISCLAIMER,
  ONCHAIN_UNATTRIBUTED_NOTICE,
  toDTag,
  verifyOnchainCall,
  type CapabilityCard,
  type OnchainCeilings,
  type OnchainDescriptor,
  type OnchainExplain,
} from '@elisym/sdk';
import { address, createSolanaRpc, getBase58Decoder } from '@solana/kit';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
// VersionedTransaction is the only @solana/web3.js type this file touches: the
// wallet-adapter API takes a legacy Transaction or a VersionedTransaction, and
// nothing in kit produces one. Same bridge as BuyContext and DelegationPanel.
import { VersionedTransaction } from '@solana/web3.js';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { readThread, recordCallSignature, type CallStatus } from '~/lib/chatThread';
import { SOLANA_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';
import { cn } from '~/lib/cn';
import { explorerTxUrl } from '~/lib/explorer';
import {
  blockingCallSignature,
  keptCallStatus,
  ceilingLabel,
  narrowedCeiling,
  seedLimit,
  sendFailureDetail,
  descriptorAsset,
  hasUnknownProgram,
  programLabel,
  refusalHeadline,
  sanitizeAmountInput,
  toCallView,
  wasBroadcast,
  type CallView,
} from '~/lib/onchainCall';

interface Props {
  /** The capability that built the call - its published promise is what we check against. */
  card: CapabilityCard & { onchain: OnchainDescriptor };
  /** The job result: the call envelope, verbatim. */
  envelope: string;
  /** The agent this chat belongs to - also the provider that built the call. */
  agentPubkey: string;
  jobEventId: string;
  /** Signature recorded for this job, when the call was already signed once. */
  signedAlready?: string;
  /** What became of that signature. A `failed` call moved nothing and may be retried. */
  signedStatus?: CallStatus;
}

interface Verified {
  transaction: string;
  lifetime: { blockhash: string; lastValidBlockHeight: bigint };
  view: CallView;
  ceilings: OnchainCeilings;
  explain?: OnchainExplain[];
}

const rpc = createSolanaRpc(SOLANA_RPC_URL);

/** Byte equality, so "sign exactly what was verified" holds through the wallet. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * The confirm sheet for a capability-built Solana call.
 *
 * Everything above the signature button is what THIS client decoded and
 * simulated; the agent's own explanation sits below, labelled. The ceilings
 * default to what the capability published and can only be lowered - the
 * verifier ignores an attempt to raise one, so the number shown is always the
 * number applied.
 */
export function OnchainCallCard({
  card,
  envelope,
  agentPubkey,
  jobEventId,
  signedAlready,
  signedStatus,
}: Props) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const { client } = useElisymClient();
  const { identity } = useIdentity();
  const asset = descriptorAsset(card.onchain);
  const publishedCeiling = BigInt(card.onchain.max_per_call_subunits);
  const publishedAuthority = BigInt(card.onchain.max_authority_subunits);
  // The digits the amount boxes hold: display units when the asset is one this
  // build knows, subunits otherwise. `sanitizeAmountInput` enforces the same.
  const inputDecimals = asset?.decimals ?? 0;

  const [checking, setChecking] = useState(false);
  const [verified, setVerified] = useState<Verified | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // A `failed` call reverted on-chain: it moved nothing, so the sheet must NOT
  // present it as done, and the customer may legitimately sign a fresh one.
  const executed = blockingCallSignature({
    ...(signedAlready === undefined ? {} : { callSignature: signedAlready }),
    ...(signedStatus === undefined ? {} : { callStatus: signedStatus }),
  });
  // DERIVED from the props, never seeded into state from them. The claim can
  // arrive AFTER this sheet has mounted: hydration recovers a signed call's
  // signature from the customer's own relay report, and the thread keys each
  // row by job id, so the card does not remount when that lands. A `useState`
  // initializer would read the props once and then ignore the very recovery it
  // exists for, leaving an already-executed call on offer as if it were fresh.
  const [localSignature, setLocalSignature] = useState<string | null>(null);
  // This flow's OWN verdict, which outranks the props while it is running.
  // `sign` writes the claim as `sent` before the bytes go out, so between the
  // broadcast and the confirmation the store - and therefore the props - say
  // `sent` for a call this client is in the middle of confirming. Reading the
  // props alone there put "could not confirm whether it landed ... buy the
  // capability again" in front of a customer whose call was landing fine,
  // which is an instruction to make a second real one.
  const [localStatus, setLocalStatus] = useState<CallStatus | null>(null);
  // The signature whose bytes provably never went out, and the signature the
  // current refusal is ABOUT. Both are held as the signature rather than as a
  // boolean, because a boolean outlives the attempt that set it: `refusal` did
  // exactly that, which is why the headline stopped reading it, and a sticky
  // `notCompleted` would inherit the same defect - heading a signature that
  // later landed, or one recovered from another device, "not completed".
  const [unsentSignature, setUnsentSignature] = useState<string | null>(null);
  const [refusalFor, setRefusalFor] = useState<string | null>(null);
  // A local `failed` hides the signed panel outright: the chain answered that
  // the call reverted, so nothing moved and the customer is owed the sheet
  // back. Otherwise a failed verdict WRITE would leave the props saying `sent`
  // and the panel would keep the floor over the refusal explaining why.
  const signature = localStatus === 'failed' ? null : (localSignature ?? executed ?? null);
  // A fact about the signature ON SCREEN, re-derived every render. A retry
  // after a preflight rejection lands a NEW signature, and hydration can
  // recover one from another device; either would inherit a sticky flag and be
  // headlined "not completed" though it executed.
  const notCompleted = unsentSignature !== null && unsentSignature === signature;
  const unconfirmed =
    localStatus !== null
      ? localStatus === 'sent'
      : executed !== undefined && signedStatus === 'sent';
  // The signature reached the chain but not this device's store, so a reload
  // may offer the sheet again. Sticky, because that hazard outlives a toast.
  const [unrecorded, setUnrecorded] = useState(false);
  // What the verifier derived about a call it refused. A customer told "this
  // moves more than you allowed" should see WHAT it moves.
  const [refusedView, setRefusedView] = useState<CallView | null>(null);
  const [sending, setSending] = useState(false);
  // Seeded WITHOUT a symbol: this string is fed straight back to the amount
  // parser, which takes digits and a dot and nothing else.
  const [spendLimit, setSpendLimit] = useState(seedLimit(publishedCeiling, asset));
  // The second bound, and a separate box: an approve moves nothing today, so
  // the spend limit above says nothing at all about it.
  const [authorityLimit, setAuthorityLimit] = useState(seedLimit(publishedAuthority, asset));

  // A call checked for one wallet must never stay on screen for another: the
  // bytes are bound to the signer they were built for, and a refusal naming a
  // wallet is about that wallet.
  const walletAddress = publicKey?.toBase58();
  const [checkedFor, setCheckedFor] = useState<string | undefined>(undefined);
  if ((verified || refusal) && checkedFor !== walletAddress) {
    setVerified(null);
    setRefusal(null);
    setRefusalFor(null);
    setCheckedFor(walletAddress);
  }

  const check = useCallback(async () => {
    if (!publicKey) {
      toast.error('Connect a wallet to review this call.');
      return;
    }
    setChecking(true);
    setRefusal(null);
    setRefusalFor(null);
    // Read the limit boxes BEFORE the verify guard: a typo in a field is the
    // customer's own input, and reporting it as "this call could not be
    // checked" would blame the provider for it.
    let ceilings: OnchainCeilings;
    try {
      const published = defaultCeilings(card.onchain);
      ceilings = {
        ...published,
        spendSubunits: narrowedCeiling(spendLimit, asset, published.spendSubunits, 'spend'),
        authoritySubunits: narrowedCeiling(
          authorityLimit,
          asset,
          published.authoritySubunits,
          'standing approval',
        ),
      };
    } catch (error) {
      setChecking(false);
      toast.error(error instanceof Error ? error.message : 'That limit is not a valid amount.');
      return;
    }
    try {
      const result = await verifyOnchainCall({
        envelope,
        card: card.onchain,
        signer: address(publicKey.toBase58()),
        network: SOLANA_CLUSTER,
        rpc,
        ceilings,
      });
      setCheckedFor(walletAddress);
      if (!result.ok) {
        setVerified(null);
        setRefusedView(result.facts ? toCallView(result.facts, card.onchain) : null);
        setRefusal(`${refusalHeadline(result.reason)} ${result.detail}`);
        setRefusalFor(null);
        return;
      }
      setRefusedView(null);
      setVerified({
        transaction: result.transaction,
        lifetime: result.lifetime,
        view: toCallView(result.facts, card.onchain),
        ceilings: result.ceilings,
        ...(result.facts.explain ? { explain: result.facts.explain } : {}),
      });
    } catch (error) {
      setVerified(null);
      setRefusedView(null);
      setCheckedFor(walletAddress);
      setRefusal(
        `This call could not be checked: ${error instanceof Error ? error.message : String(error)}`,
      );
      setRefusalFor(null);
    } finally {
      setChecking(false);
    }
  }, [asset, authorityLimit, card.onchain, envelope, publicKey, spendLimit, walletAddress]);

  const sign = useCallback(async () => {
    if (!verified || !signTransaction) {
      return;
    }
    setSending(true);
    // `broadcast` flips the instant the bytes are handed to the RPC, not when
    // it answers: a send whose RESPONSE leg fails may still have reached the
    // cluster, and the SDK's own settlement rule is that only a poll may decide
    // that. Reporting such a call as "not sent" invites a second, real one.
    let sent: string | undefined;
    let broadcast = false;
    let settled = false;
    // Whether the claim below actually reached the store. A claim that was
    // never written cannot be the thing blocking a retry, and telling the
    // customer it is sends them hunting for an entry that does not exist.
    let claimed = false;
    // Whether a claim is still recorded against this job. That makes the signed
    // panel take the floor and hide the refusal explaining why, so the
    // explanation has to reach the customer another way - and any advice to
    // "check it again" is advice the store will then refuse.
    //
    // Set from BOTH arms. The flag this replaced was assigned only inside the
    // send catch, which always throws, so it was provably `true` on the settled
    // path and the advice there could never be dropped - which is exactly where
    // the contradiction lived.
    let claimStanding = false;
    try {
      // Re-read the store first. The thread snapshot this component renders is
      // per-tab, so the same chat open twice would otherwise let the second tab
      // sign a call the first already sent - and a re-check there builds a
      // fresh transaction that lands for real.
      const stored = await readThread(agentPubkey);
      const prior = stored.find((entry) => entry.jobEventId === jobEventId);
      const blocking = prior === undefined ? undefined : blockingCallSignature(prior);
      if (blocking !== undefined) {
        setLocalSignature(blocking);
        setLocalStatus(
          keptCallStatus(blocking, prior?.callStatus, {
            signature: localSignature,
            status: localStatus,
          }),
        );
        toast.error(
          'This call was already signed and sent. Check that signature before signing again.',
        );
        return;
      }
      const bytes = Uint8Array.from(atob(verified.transaction), (char) => char.charCodeAt(0));
      const checked = VersionedTransaction.deserialize(bytes);
      const signed = await signTransaction(checked);
      // What gets broadcast is whatever the wallet returned, so compare its
      // message back against the bytes the verifier approved. Only the
      // signatures may differ.
      if (!sameBytes(signed.message.serialize(), checked.message.serialize())) {
        throw new Error('the wallet returned a different transaction than the one elisym checked');
      }
      // Re-read once more, now that the wallet prompt is behind us and BEFORE
      // anything reaches the network: another tab may have signed this job
      // while a human was looking at the dialog.
      const raced = (await readThread(agentPubkey)).find(
        (entry) => entry.jobEventId === jobEventId,
      );
      const racedSignature = raced === undefined ? undefined : blockingCallSignature(raced);
      if (racedSignature !== undefined) {
        // Same outcome as the pre-read above, so the same words and the same
        // signature: this one is the sibling the customer has to go and check.
        setLocalSignature(racedSignature);
        setLocalStatus(
          keptCallStatus(racedSignature, raced?.callStatus, {
            signature: localSignature,
            status: localStatus,
          }),
        );
        toast.error(
          'This call was already signed and sent. Check that signature before signing again.',
        );
        return;
      }
      // Derived from the signed bytes rather than taken from the send's reply,
      // so the handle on this transaction exists before anything can go wrong
      // with that reply. `signatures` is pre-allocated to zero-filled slots, so
      // an unsigned transaction reads back as a valid-looking string of zeros
      // rather than as nothing at all.
      const attached = signed.signatures[0];
      if (attached === undefined || attached.every((byte) => byte === 0)) {
        throw new Error('the wallet returned the transaction unsigned');
      }
      sent = getBase58Decoder().decode(attached);
      // CLAIMED BEFORE THE BYTES GO OUT, like the MCP client. Recording after
      // the send resolves leaves a window of a second or two in which the tab
      // can be closed with the transaction already on the wire and nothing in
      // the store - and relay hydration cannot restore it, because a hydrated
      // entry deliberately carries no `callSignature`. A reload would then
      // offer the sheet again, and a re-check builds a fresh-blockhash
      // transaction that genuinely lands.
      const claim = await recordCallSignature(agentPubkey, jobEventId, sent, 'sent');
      // ABORT rather than send. `superseded` means a different blocking
      // signature reached the store between the read above and this write -
      // another tab, or the hydration merge recovering a call another device
      // already landed. Overwriting it and sending anyway would be the paid
      // action executed twice, which is the whole thing this claim exists to
      // stop; the bytes have not gone out yet, so stopping here costs nothing.
      if (claim === 'superseded') {
        // Re-read to SHOW the signature this refusal tells them to check.
        // Nothing else will surface it: a `superseded` write changes no entry,
        // so the store does not notify, and a claim written by another tab
        // never bumps this tab's version at all - so the props would carry it
        // no sooner than the next hydration cycle, up to a minute away.
        const winner = (await readThread(agentPubkey)).find(
          (entry) => entry.jobEventId === jobEventId,
        );
        const winning = winner === undefined ? undefined : blockingCallSignature(winner);
        if (winning !== undefined) {
          setLocalSignature(winning);
          setLocalStatus(winner?.callStatus ?? 'sent');
          // The winner IS stored - that is why this claim was superseded - so a
          // warning left over from an earlier attempt of this tab would sit
          // under someone else's signature saying it was not recorded. The last
          // flag in this card that outlived the attempt that set it; `refusal`
          // and `notCompleted` were fixed for the same reason.
          setUnrecorded(false);
        }
        setVerified(null);
        setCheckedFor(walletAddress);
        setRefusal(
          'This job was signed elsewhere while you were confirming - on another tab, or on ' +
            'another device using this identity. Nothing was sent from here. Check that ' +
            'signature before signing anything again.',
        );
        // About the WINNER, which is the signature the panel will show.
        setRefusalFor(winning ?? null);
        toast.error('This job was already signed elsewhere. Nothing was sent from here.');
        return;
      }
      claimed = claim === 'stored';
      setUnrecorded(!claimed);
      broadcast = true;
      try {
        await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
        });
      } catch (error) {
        // A preflight rejection is the one send failure a retry is provably safe
        // after; anything else may have reached the cluster. See `wasBroadcast`.
        broadcast = wasBroadcast(error);
        if (!broadcast) {
          // Provably never forwarded, so the claim is released: `failed` is the
          // one status `blockingCallSignature` does not treat as blocking. If
          // THAT write does not stick the claim stands, and the customer has to
          // be told - otherwise the next Sign is refused forever for a call
          // that never went out.
          claimStanding =
            claimed &&
            (await recordCallSignature(agentPubkey, jobEventId, sent, 'failed')) !== 'stored';
        }
        const detail = sendFailureDetail(error);
        throw new Error(
          claimStanding
            ? `${detail} - and this device still has the call stored as sent, so this sheet will ` +
                'refuse a retry. Buy the capability again for a fresh call.'
            : detail,
        );
      }

      // Confirm against the lifetime the verifier set before calling it done:
      // the signature is reported to the provider as a completion, so claiming
      // one for a transaction that never landed would poison that record.
      const confirmation = await connection.confirmTransaction(
        {
          signature: sent,
          blockhash: verified.lifetime.blockhash,
          lastValidBlockHeight: Number(verified.lifetime.lastValidBlockHeight),
        },
        'confirmed',
      );
      settled = true;
      // A call can land in a block and still revert. Nothing moved, so this is
      // a failure the customer may retry - and reporting it as a completion
      // would tell the provider its call executed when it did not.
      if (confirmation.value.err) {
        // Recorded as failed, not left as `sent`: otherwise the pre-read above
        // would treat this job as executed and block the legitimate retry the
        // refusal message is about to offer.
        const noted =
          !claimed ||
          (await recordCallSignature(agentPubkey, jobEventId, sent, 'failed')) === 'stored';
        claimStanding = !noted;
        // This flow's verdict, so the props cannot speak over it. Without it a
        // failed `failed` write leaves the store saying `sent`, the signed
        // panel takes the floor, and it tells the customer "this client could
        // not confirm whether it landed ... if the explorer has no such
        // transaction, it never went out". The client DID confirm, the
        // explorer WILL show it, and following that sentence means concluding
        // the action happened when nothing moved and a retry is owed.
        setLocalStatus('failed');
        // The SIGNATURE moves with the status, always. `keptCallStatus` refuses
        // to lower a terminal verdict only for the signature it is about, so a
        // status set without one leaves the guard inert on exactly the path it
        // was written for: the customer re-checks, the pre-read finds the
        // uncommitted store's `sent`, and the panel says "could not confirm
        // whether it landed" beside "it failed on-chain".
        setLocalSignature(sent);
        throw new Error(
          `it failed on-chain (${JSON.stringify(confirmation.value.err)})${
            noted
              ? ''
              : ', and this device could not record that - it still has the call stored as sent, ' +
                'so this sheet will refuse a retry. Buy the capability again for a fresh call.'
          }`,
        );
      }
      // The verdict write is what clears an earlier failed `sent` write, so its
      // result decides the sticky notice rather than being dropped.
      // `claimed ||`, like the two paths above: if the pre-send claim stuck, a
      // failed verdict write leaves `sent` standing, which still blocks the
      // sheet. Warning that a reload "may offer this call again" would be the
      // same false claim-status message in the opposite direction.
      const recorded =
        (await recordCallSignature(agentPubkey, jobEventId, sent, 'landed')) === 'stored';
      setUnrecorded(!(claimed || recorded));
      // The chain answered, so this flow's verdict stands even if the store
      // write above failed and the props still say `sent`. Otherwise a call
      // that demonstrably landed would carry "could not confirm" forever.
      setLocalStatus('landed');
      setLocalSignature(sent);
      // Best-effort: the provider learns its call was executed. A relay failure
      // never invalidates a transaction that already landed.
      try {
        await client.marketplace.reportCallSignature(identity, jobEventId, agentPubkey, sent, {
          capability: toDTag(card.name),
          network: SOLANA_CLUSTER,
        });
      } catch {
        /* reporting is not part of the money path */
      }
      toast.success('Call signed and sent.');
    } catch (error) {
      // Through the same normalizer as the send leg: a wallet rejection reads
      // "User rejected the request." and both sentences below append a full
      // stop of their own.
      const message = sendFailureDetail(error);
      if (sent !== undefined && broadcast && !settled) {
        // On the wire, verdict unknown - including when the send itself threw,
        // since the bytes may have reached the cluster before the reply failed.
        // Record it here too: a throw from `sendRawTransaction` skipped the
        // write below, and an unrecorded signature is a second call waiting to
        // happen.
        const kept =
          (await recordCallSignature(agentPubkey, jobEventId, sent, 'sent')) === 'stored';
        setUnrecorded(!(claimed || kept));
        setLocalStatus('sent');
        setLocalSignature(sent);
        toast.error(
          `The call was sent but could not be confirmed (${message}). Check the signature in the ` +
            'explorer before signing anything else.',
        );
        return;
      }
      // Either the chain answered, or these bytes never left. Both leave a
      // verified call the customer cannot usefully sign - the blockhash is
      // spent in the first case and stale in the second - so send them back to
      // "Check this call" rather than leaving a button that can only fail.
      setVerified(null);
      setCheckedFor(walletAddress);
      // Toasted as well as written into the panel, because the panel is only
      // rendered while no signature is showing. A call that reverted on chain
      // records `failed` and so clears that - but if THAT write does not stick,
      // the claim stays `sent`, the signed panel keeps the floor, and the
      // refusal would never reach the customer at all.
      // A signature on screen with the bytes provably unsent: only here may the
      // panel contradict its own headline, and only for THIS signature.
      if (sent !== undefined && !broadcast) {
        setUnsentSignature(sent);
      }
      setRefusalFor(sent ?? null);
      if (settled || claimStanding) {
        toast.error(
          settled ? `The call was sent and ${message}.` : `The call was not sent: ${message}.`,
        );
      }
      // The trailing advice is dropped whenever the claim is still standing:
      // "check it again" is the one action the store will refuse, and the
      // message already carries the next step ("buy the capability again").
      // Both branches, not just one - and the sentence still ends in a stop.
      setRefusal(
        settled
          ? `This call was sent and ${message}.${
              claimStanding ? '' : ' Check it again, or ask the capability for a fresh one.'
            }`
          : `This call never reached the network: ${message}.${
              claimStanding ? '' : ' Check it again before signing.'
            }`,
      );
    } finally {
      setSending(false);
    }
  }, [
    agentPubkey,
    card.name,
    client.marketplace,
    connection,
    identity,
    jobEventId,
    // Read by the two pre-read guards, which hand them to `keptCallStatus`.
    // Omitted, they were stale whenever `verified` had not changed since the
    // last render - which is precisely the retry-after-failure path.
    localSignature,
    localStatus,
    signTransaction,
    verified,
    walletAddress,
  ]);

  // `!sending`, so the panel appears only once the flow has finished. During the
  // send the verified panel stays up with its own disabled "Signing..." button;
  // every terminal path clears `sending` before this can be reached.
  if (signature && !sending) {
    return (
      <div className="flex w-full max-w-[85%] flex-col gap-8 rounded-14 border border-border bg-surface p-12 text-xs sm:max-w-[70%]">
        {/* The headline follows the refusal, not the store. A preflight
            rejection proves the bytes never left, but if the release write does
            not commit the store still says `sent` and this panel takes the
            floor - so a fixed "Call signed and sent" would sit directly above
            "This call never reached the network".

            Driven by `notCompleted`, NOT by `refusal`. A refusal is whatever
            the last failed anything wrote, and it outlives the check that wrote
            it: a stale "this call has expired" on a second device, still on
            screen when hydration recovers the signature of a withdrawal the
            first device already made, would head that signature "This call was
            not completed" and send the customer to make it again. */}
        <span className="font-medium">
          {notCompleted ? 'This call was not completed' : 'Call signed and sent'}
        </span>
        {/* Only a refusal ABOUT this signature. A `check` refusal - an expired
            envelope, say - is about no signature at all, and it outlives the
            check that wrote it: left unguarded it sat over a signature hydration
            had since recovered from another device, telling the customer to ask
            for a fresh call and sign the same paid action twice. */}
        {refusal && refusalFor === signature && <span className="text-text-2">{refusal}</span>}
        {/* Suppressed only where the bytes provably never left, which is the
            one state where "could not confirm whether it landed" is false. */}
        {unconfirmed && !notCompleted && (
          <span className="text-text-2">
            This client could not confirm whether it landed. Check the signature before signing
            anything else - signing again would execute a second, real call. If the explorer has no
            such transaction, it never went out: buy the capability again for a fresh call.
          </span>
        )}
        {unrecorded && (
          <span className="text-text-2">
            This device could not store the signature, so a reload may offer this call again. Check
            the signature first - signing again would execute a second, real call.
          </span>
        )}
        <a
          className="break-all text-accent underline"
          href={explorerTxUrl(signature)}
          target="_blank"
          rel="noreferrer"
        >
          {signature}
        </a>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-[85%] flex-col gap-10 rounded-14 border border-border bg-surface p-12 text-xs sm:max-w-[70%]">
      <span className="font-medium">This capability returned a Solana call to sign.</span>

      {!verified && (
        <>
          <label className="flex flex-col gap-4">
            <span className="text-text-2">
              Most you allow this call to move ({asset?.symbol ?? 'subunits'}), never more than this
              capability publishes now
            </span>
            <input
              className="rounded-8 border border-border bg-bg-page px-8 py-6 font-mono"
              value={spendLimit}
              inputMode="decimal"
              onChange={(event) =>
                setSpendLimit(sanitizeAmountInput(event.target.value, inputDecimals))
              }
            />
          </label>
          {card.onchain.grants_authority && (
            <label className="flex flex-col gap-4">
              <span className="text-text-2">
                Most you allow this call to authorize someone else to move LATER (
                {asset?.symbol ?? 'subunits'}). This survives the transaction until you revoke it.
              </span>
              <input
                className="rounded-8 border border-border bg-bg-page px-8 py-6 font-mono"
                value={authorityLimit}
                inputMode="decimal"
                onChange={(event) =>
                  setAuthorityLimit(sanitizeAmountInput(event.target.value, inputDecimals))
                }
              />
            </label>
          )}
          <button
            type="button"
            className="btn self-start btn-outline disabled:cursor-not-allowed disabled:opacity-50"
            disabled={checking}
            onClick={check}
          >
            {checking ? 'Checking the call…' : 'Check this call'}
          </button>
        </>
      )}

      {refusal && (
        <div className="flex flex-col gap-4 rounded-8 bg-feedback-negative-bg px-8 py-6">
          <p className="m-0 break-words">{refusal}</p>
          {/* What the verifier managed to derive before it refused. Being told
              a call moves more than allowed is only half the story. */}
          {refusedView?.movements.map((movement) => (
            <span
              key={`${movement.direction}${movement.amount}${movement.symbol}`}
              className="font-mono"
            >
              {movement.direction}
              {movement.amount} {movement.symbol}
            </span>
          ))}
          {/* Grants too, not only movements. An `authority-ceiling-exceeded`
              refusal is ABOUT an approval, and without these rows the only
              number on screen was the verifier's raw subunits inside the
              detail sentence - beside limit boxes in display units. */}
          {refusedView?.grants.map((grant) => (
            <span key={`${grant.delegate}${grant.account}`} className="break-all">
              {grant.delegate} may move up to {grant.amount} {grant.symbol} from {grant.account}{' '}
              after this call, until you revoke it.
            </span>
          ))}
          {refusedView !== null && refusedView.unattributed.length > 0 && (
            <span>{ONCHAIN_UNATTRIBUTED_NOTICE}</span>
          )}
          {/* A refusal is a verdict on a call, and the docs promise this
              sentence on every one. MCP's refusal already carries it; this
              surface did not, so a customer read "elisym refused this" as a
              judgement about the PROGRAM rather than about the bounds. */}
          <span className="text-text-2">{ONCHAIN_DISCLAIMER}</span>
        </div>
      )}

      {verified && (
        <>
          <div className="flex flex-col gap-4">
            <span className="text-text-2">What this call does to your wallet:</span>
            {verified.view.movesNothing && (
              <span>No value moves out of the accounts elisym can see.</span>
            )}
            {verified.view.movements.map((movement) => (
              <span
                key={`${movement.direction}${movement.amount}${movement.symbol}`}
                className={cn(
                  'font-mono',
                  // The asset the ceilings are about, marked so a customer can
                  // see at a glance which row the limit below applies to.
                  movement.isCardAsset && 'font-medium',
                  movement.direction === '-' && 'text-feedback-negative',
                )}
              >
                {movement.direction}
                {movement.amount} {movement.symbol}
              </span>
            ))}
            <span className="text-text-2">Network fee: {verified.view.fee} SOL</span>
          </div>

          {verified.view.unattributed.length > 0 && (
            <div className="flex flex-col gap-4 rounded-8 bg-feedback-negative-bg px-8 py-6">
              <span className="font-medium">{ONCHAIN_UNATTRIBUTED_NOTICE}</span>
              {verified.view.unattributed.map((account) => (
                <span key={account} className="break-all">
                  {account}
                </span>
              ))}
            </div>
          )}

          {verified.view.grants.length > 0 && (
            <div className="flex flex-col gap-4 rounded-8 bg-feedback-negative-bg px-8 py-6">
              <span className="font-medium">This call leaves a standing approval:</span>
              {verified.view.grants.map((grant) => (
                <span key={`${grant.delegate}${grant.account}`} className="break-all">
                  {grant.delegate} may move up to {grant.amount} {grant.symbol} from {grant.account}{' '}
                  after this call, until you revoke it.
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-4">
            <span className="text-text-2">Programs it calls:</span>
            {verified.view.programs.map((programId) => (
              <span key={programId} className="break-all">
                {programId} - {programLabel(programId)}
              </span>
            ))}
            {verified.view.innerPrograms.length > 0 && (
              <span className="break-all text-text-2">
                Reached inside: {verified.view.innerPrograms.join(', ')}
              </span>
            )}
            {hasUnknownProgram(verified.view) && (
              <span className="font-medium">
                At least one of these programs is not known to us.
              </span>
            )}
          </div>

          {verified.explain && verified.explain.length > 0 && (
            <div className="flex flex-col gap-4 rounded-8 bg-surface-2 px-8 py-6">
              <span className="text-text-2">What the agent says about it (its own words):</span>
              {verified.explain.map((line, index) => (
                <span key={`${line.kind}-${index}`} className="break-words text-text-2">
                  {[line.kind, line.amount, line.asset, line.to, line.note]
                    .filter((part) => part !== undefined && part !== '')
                    .join(' ')}
                </span>
              ))}
            </div>
          )}

          <span className="text-text-2">
            Limits applied, against what this capability published when this page loaded its card:
            at most {ceilingLabel(verified.ceilings.spendSubunits, asset)} may leave your wallet
            {card.onchain.grants_authority
              ? `, and at most ${ceilingLabel(verified.ceilings.authoritySubunits, asset)} may be authorized for later`
              : ''}
            {/* Named separately because the network fee rides THIS bound on
                every card, including one priced in SOL. Stating only the spend
                ceiling would promise a limit the verifier does not apply to the
                fee, and this much more can leave than that sentence admits. */}
            , plus at most {ceilingLabel(verified.ceilings.incidentalLamports, NATIVE_SOL)} for the{' '}
            {card.onchain.mint === undefined
              ? 'network fee'
              : 'network fee, account rent and any other SOL it moves'}
            .
          </span>

          <p className="m-0 text-text-2">{ONCHAIN_DISCLAIMER}</p>

          {!signTransaction && (
            <span className="text-text-2">
              This wallet cannot sign a transaction without sending it itself, so elisym cannot hand
              it these exact bytes. Connect a wallet that supports signing.
            </span>
          )}
          <button
            type="button"
            className="btn-primary btn self-start disabled:cursor-not-allowed disabled:opacity-50"
            disabled={sending || !signTransaction}
            onClick={sign}
          >
            {sending ? 'Signing…' : 'Sign and send'}
          </button>
        </>
      )}
    </div>
  );
}
