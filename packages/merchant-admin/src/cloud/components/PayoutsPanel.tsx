import type { NostrEvent } from 'nostr-tools/pure';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import {
  type OwnerEventsRead,
  currentPayoutList,
  decisionText,
  readOwnerEvents,
  revocationInForce,
  signingDecision,
} from '../lib/owner-events';
import type { OwnerTools } from '../lib/owner-tools';
import {
  type PayoutRow,
  payoutAddress,
  payoutAssets,
  payoutRows,
  signOwnerEvents,
} from '../lib/payouts';
import { ALL_RAILS, choiceOf, railsOf, withRailsOn } from '../lib/settings';
import { shownTime } from '../lib/store-view';
import type { KeptStore } from '../lib/use-kept-store';
import { WalletRefused, proveWithWallet } from '../lib/wallet';
import { Card } from './Card';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  storePubkey: string;
  network: 'mainnet' | 'devnet';
  kept: KeptStore;
  tools: OwnerTools;
  /** Launched: before it, a signed list is only kept, and goes out at launch. */
  activated: boolean;
  /** Off sale: a signed list is only kept, and goes out at Resume. */
  withdrawn: boolean;
  /** The store changed here (withdrawn): its view is read again. */
  onStoreChanged: () => void;
  /** The list signed here is kept by the store. */
  onSettled?: () => void;
}

/** A rail as the merchant reads it. */
const RAIL_NAMES: Record<string, string> = {
  solana: 'Solana',
  tempo: 'Tempo',
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  base: 'Base',
};

/**
 * Where the store's payments go: the owner's payout list, started from the
 * owner's own newest list on the relays (never from cloud-api), edited (each
 * new payout proved with its wallet, or pasted and shown as not verified), and
 * signed with the store's AUTH at the local clock, when the date rules allow.
 * Rails follow payouts, upward only: a payout on a rail the store keeps off
 * first saves the store with that rail on, and signs once it is kept.
 */
export function PayoutsPanel({
  api,
  tenantId,
  storePubkey,
  network,
  kept,
  tools,
  activated,
  withdrawn,
  onStoreChanged,
  onSettled,
}: Props) {
  const { signer, relayQuery, wallets, operator, localNow } = tools;
  const form = kept.read?.waitingForm ?? kept.read?.form;
  // Any coin of the network: its rail is turned on when the list is signed.
  const allowedAssets = form === undefined ? [] : payoutAssets(network, new Set(ALL_RAILS));
  const allowedKey = allowedAssets.map((asset) => asset.caip19).join(' ');
  const [rows, setRows] = useState<PayoutRow[] | undefined>(undefined);
  const [dropped, setDropped] = useState(0);
  const [asset, setAsset] = useState('');
  const [address, setAddress] = useState('');
  const [reauthorize, setReauthorize] = useState(false);
  const [notice, setNotice] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // Withdrawing takes the products off sale: a second click confirms it.
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const inFlight = useRef(false);
  // Rails saved on for this list, and the store read that says whether they are kept.
  const [railsWait, setRailsWait] = useState<{ rails: string[]; seq: number } | undefined>();

  // The relays, read in the page: each read is numbered; a read-back verdict counts only from a
  // read asked for after what it checks (a save, a kept edit, a launch or Resume, a check again).
  const [relay, setRelay] = useState<{ seq: number; read: OwnerEventsRead } | undefined>(undefined);
  const [relayFailed, setRelayFailed] = useState(false);
  const askedRef = useRef(1);
  const [asked, setAsked] = useState(1);
  const [needed, setNeeded] = useState(1);
  const askRead = () => {
    askedRef.current += 1;
    setNeeded(askedRef.current);
    setAsked(askedRef.current);
  };
  // What was signed here: the date rules count it before the relays show it; the read-back never.
  const [signedHere, setSignedHere] = useState<{ lists: NostrEvent[]; auths: NostrEvent[] }>({
    lists: [],
    auths: [],
  });
  const [signedId, setSignedId] = useState<string | undefined>(undefined);
  // After a save, a launch or a Resume: the store read asked for then, which says whether its setup
  // still waits (none while null).
  const [waitRead, setWaitRead] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    const seq = asked;
    const read = async () => {
      try {
        const events = await readOwnerEvents(relayQuery, signer.pubkey, storePubkey);
        if (current) {
          setRelay({ seq, read: events });
          setRelayFailed(false);
        }
      } catch {
        if (current) {
          // The last good read stays: signing goes on from it, and a retry is offered.
          setRelayFailed(true);
        }
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [relayQuery, signer, storePubkey, asked]);

  // A setup that stops waiting (an edit kept, a launch or Resume run) has published: the relays
  // are read again.
  const pending = kept.read?.pending === true || kept.read?.publishing === true;
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending) {
      askRead();
    }
    wasPending.current = pending;
  }, [pending]);

  // The store read asked for after a save (or a launch) decides: still waiting (the relays are read
  // once it ran), or not (they are read now: a cloud that says nothing waits cannot skip the read-back).
  useEffect(() => {
    if (waitRead === null || kept.readSeq < waitRead) {
      return;
    }
    setWaitRead(null);
    if (!pending) {
      askRead();
    }
  }, [waitRead, kept.readSeq, pending]);

  // Launched or resumed (or withdrawn) here: what goes out changes. As after a save, the read-back
  // waits for a fresh store read (its setup may still be to run), then for the relays after it.
  const launchState = `${activated} ${withdrawn}`;
  const lastLaunchState = useRef(launchState);
  useEffect(() => {
    if (lastLaunchState.current !== launchState) {
      lastLaunchState.current = launchState;
      setNeeded(Number.POSITIVE_INFINITY);
      setWaitRead(kept.reload());
    }
  }, [launchState, kept]);

  // The date rules' read: the relays, with what was signed here.
  const signingRead: OwnerEventsRead | undefined =
    relay === undefined
      ? undefined
      : {
          payoutLists: [...relay.read.payoutLists, ...signedHere.lists],
          revocations: relay.read.revocations,
          auths: [...relay.read.auths, ...signedHere.auths],
        };

  // The rows start from the owner's newest list, once its events and the store's rails are known.
  useEffect(() => {
    if (rows !== undefined || relay === undefined || form === undefined) {
      return;
    }
    const started = payoutRows(
      currentPayoutList(relay.read, localNow()),
      new Set(allowedKey.split(' ').filter((caip19) => caip19 !== '')),
    );
    setRows(started.rows);
    setDropped(started.dropped);
  }, [rows, relay, form, allowedKey, localNow]);

  const labelOf = (caip19: string) =>
    allowedAssets.find((each) => each.caip19 === caip19)?.label ?? caip19;

  const add = async () => {
    if (inFlight.current || rows === undefined) {
      return;
    }
    if (asset === '') {
      setNotice('Choose what the payout is paid in.');
      return;
    }
    if (rows.some((row) => row.caip19 === asset)) {
      setNotice(`There is already a payout in ${labelOf(asset)}: remove it first.`);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      const proved = await proveWithWallet(wallets, {
        ownerPubkey: signer.pubkey,
        caip19: asset,
        address,
      });
      setRows([...rows, { caip19: asset, address: proved.address, signature: proved.signature }]);
      setAddress('');
      setSaved(false);
    } catch (error) {
      setNotice(error instanceof WalletRefused ? error.message : 'The wallet failed: try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // An unproved row proved with its wallet: replaced by the proved one, in place.
  const verify = async (row: PayoutRow) => {
    if (inFlight.current || rows === undefined) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    try {
      const proved = await proveWithWallet(wallets, {
        ownerPubkey: signer.pubkey,
        caip19: row.caip19,
        address: row.address,
      });
      setRows(
        rows.map((each) =>
          each.caip19 === row.caip19
            ? { caip19: row.caip19, address: proved.address, signature: proved.signature }
            : each,
        ),
      );
      setSaved(false);
    } catch (error) {
      setNotice(error instanceof WalletRefused ? error.message : 'The wallet failed: try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // A pasted address, not proved by its wallet: taken, and shown as not verified.
  const addUnproved = () => {
    if (inFlight.current || rows === undefined) {
      return;
    }
    if (asset === '') {
      setNotice('Choose what the payout is paid in.');
      return;
    }
    if (rows.some((row) => row.caip19 === asset)) {
      setNotice(`There is already a payout in ${labelOf(asset)}: remove it first.`);
      return;
    }
    const canonical = payoutAddress(asset, address);
    if (canonical === undefined) {
      setNotice(`That is not an address ${labelOf(asset)} can be paid to.`);
      return;
    }
    setNotice('');
    setRows([...rows, { caip19: asset, address: canonical }]);
    setAddress('');
    setSaved(false);
  };

  /** `resumed`: called once the rails this list waited for are kept. */
  const sign = async (resumed = false) => {
    if (
      inFlight.current ||
      rows === undefined ||
      signingRead === undefined ||
      (railsWait !== undefined && !resumed)
    ) {
      return;
    }
    if (rows.length === 0) {
      setNotice('Add at least one payout: a store with none cannot be paid.');
      return;
    }
    const keptForm = kept.read?.form;
    if (keptForm === undefined || form === undefined) {
      return;
    }
    const needed = [
      ...new Set(
        rows
          .map((row) => allowedAssets.find((each) => each.caip19 === row.caip19)?.rail)
          .filter((rail) => rail !== undefined),
      ),
    ].filter((rail) => rail !== undefined);
    // Saved on when the settings the store will have (a waiting edit, else the kept ones) lack a
    // rail, a waiting edit that turns one off included; signed only once the store keeps them all.
    const willHave = railsOf(form);
    const missing = needed.filter((rail) => !willHave.has(rail));
    const keptRails = railsOf(keptForm);
    const notKept = needed.filter((rail) => !keptRails.has(rail));
    if (missing.length === 0 && notKept.length > 0) {
      setRailsWait({ rails: notKept, seq: kept.reload() });
      return;
    }
    if (missing.length > 0) {
      inFlight.current = true;
      setBusy(true);
      setNotice('');
      setProblems([]);
      const stored = await api.request(
        'POST',
        `/tenants/${tenantId}/store`,
        choiceOf(withRailsOn(form, missing)),
      );
      inFlight.current = false;
      setBusy(false);
      if (stored.status !== 200) {
        const detail = fieldOf(stored.body, 'detail');
        if (fieldOf(stored.body, 'error') === 'store_refused' && typeof detail === 'string') {
          setProblems(detail.split('\n'));
        } else {
          setNotice(explainAnswer(stored.body, stored.status));
        }
        return;
      }
      setRailsWait({ rails: notKept, seq: kept.reload() });
      return;
    }
    // The node's own word: a revocation the console's read may not see is signed past only by choice.
    if (kept.read?.ownerRefusal === 'revoked' && !reauthorize) {
      setNotice('You revoked this store. Re-authorize it to sign, or withdraw it.');
      return;
    }
    const decision = signingDecision({
      localNow: localNow(),
      serverNow: api.serverNow(),
      read: signingRead,
      reauthorize,
    });
    const refusal = decisionText(decision);
    if (decision.kind !== 'sign' || refusal !== undefined) {
      setNotice(refusal ?? '');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    setProblems([]);
    setSaved(false);
    const events = signOwnerEvents({
      signer,
      storePubkey,
      operator,
      rows,
      createdAt: decision.createdAt,
    });
    const answer = await api.request('POST', `/tenants/${tenantId}/owner-events`, events);
    inFlight.current = false;
    setBusy(false);
    if (answer.status === 200) {
      setSaved(true);
      setSignedId(events.payoutList.id);
      // What was signed is the owner's newest: the next signing waits after it.
      setSignedHere({
        lists: [...signedHere.lists, events.payoutList],
        auths: [...signedHere.auths, events.auth],
      });
      // The read-back waits for a fresh store read, then for the relays read after it.
      setNeeded(Number.POSITIVE_INFINITY);
      setWaitRead(kept.reload());
      return;
    }
    const detail = fieldOf(answer.body, 'detail');
    if (fieldOf(answer.body, 'error') === 'store_refused' && typeof detail === 'string') {
      setProblems(detail.split('\n'));
      return;
    }
    setNotice(explainAnswer(answer.body, answer.status));
  };

  // The newest sign, for the effect that resumes it once the rails are kept.
  const signRef = useRef(sign);
  useEffect(() => {
    signRef.current = sign;
  });

  // The rails saved for this list: kept, the list is signed; refused, the store says why.
  useEffect(() => {
    if (railsWait === undefined || kept.readSeq < railsWait.seq || kept.read === undefined) {
      return;
    }
    const on = railsOf(kept.read.form);
    if (railsWait.rails.every((rail) => on.has(rail))) {
      setRailsWait(undefined);
      void signRef.current(true);
    } else if (!kept.read.pending) {
      setRailsWait(undefined);
      if (kept.read.refused === undefined) {
        setNotice('Could not turn on the rails your payouts need: try again.');
      } else {
        setProblems(kept.read.refused);
      }
    }
  }, [railsWait, kept.readSeq, kept.read]);

  // Said once per list signed here, when the store keeps it.
  const keptListId = kept.read?.keptPayoutList?.id;
  const settledFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (signedId !== undefined && keptListId === signedId && settledFor.current !== signedId) {
      settledFor.current = signedId;
      onSettled?.();
    }
  }, [signedId, keptListId, onSettled]);

  const withdraw = async () => {
    if (inFlight.current) {
      return;
    }
    if (!confirmWithdraw) {
      setConfirmWithdraw(true);
      return;
    }
    setConfirmWithdraw(false);
    inFlight.current = true;
    setBusy(true);
    const answer = await api.request('POST', `/tenants/${tenantId}/withdraw`);
    inFlight.current = false;
    setBusy(false);
    setNotice(
      answer.status === 200
        ? 'The store is being withdrawn: its products go off sale.'
        : explainAnswer(answer.body, answer.status),
    );
    if (answer.status === 200) {
      onStoreChanged();
    }
  };

  // The list that should be on the relays (signed here, else the one the store keeps), and what is:
  // judged from the relays alone, from a read asked for after what it checks.
  const expectedId = signedId ?? kept.read?.keptPayoutList?.id;
  let goesOut: 'launch' | 'resume' | 'live' | 'missing' | 'waiting' | undefined;
  if (expectedId === undefined || relay === undefined) {
    goesOut = undefined;
  } else if (pending) {
    goesOut = 'waiting';
  } else if (relay.seq < needed || launchState !== lastLaunchState.current) {
    // A launch, a Resume or a save not read back yet (decided as the new props render, not after).
    goesOut = undefined;
  } else if (!activated) {
    goesOut = 'launch';
  } else if (withdrawn) {
    goesOut = 'resume';
  } else {
    goesOut = currentPayoutList(relay.read, localNow())?.id === expectedId ? 'live' : 'missing';
  }
  const keptAt = kept.read?.keptPayoutList?.createdAt;
  const liveText =
    signedId === expectedId || keptAt === undefined
      ? 'Live: the relays show the payout list you signed.'
      : `Live: the relays show the payout list the store keeps, signed ${shownTime(keptAt)}.`;

  // Named whatever the clocks say, and whatever the console's own read shows when the node says so.
  const revoked =
    kept.read?.ownerRefusal === 'revoked' ||
    (signingRead !== undefined && revocationInForce(signingRead, localNow()) !== undefined);

  return (
    <Card title="Payouts">
      <p className="text-14 text-text-2 mt-8 leading-relaxed">
        Where buyers&apos; payments go: your own wallets, signed by your owner key. Each new payout
        is proved with its wallet before you sign.
      </p>
      {relay === undefined && !relayFailed ? (
        <p className="text-14 text-text-3 mt-12">Reading your payouts from the relays...</p>
      ) : null}
      {relayFailed ? (
        <div role="alert" className="text-14 text-error mt-12 flex flex-col items-start gap-8">
          <p>Could not read your payouts from the relays.</p>
          <Button onClick={askRead} size="sm">
            Read the relays again
          </Button>
        </div>
      ) : null}
      {kept.read?.ownerRefusal === 'resign' ? (
        <p role="alert" className="text-14 text-error mt-12">
          The store needs your payouts signed again before it can go on.
        </p>
      ) : null}
      {revoked ? (
        <div className="rounded-12 bg-warn-bg text-14 text-warn mt-12 flex flex-col gap-8 p-12">
          <p>You revoked this store. Signing again authorizes it again; otherwise withdraw it.</p>
          <label className="flex items-center gap-8">
            <input
              type="checkbox"
              checked={reauthorize}
              onChange={(event) => setReauthorize(event.target.checked)}
            />
            Re-authorize this store
          </label>
          <Button disabled={busy} onClick={() => void withdraw()} className="self-start">
            {confirmWithdraw
              ? 'Confirm: withdraw the store (its products go off sale)'
              : 'Withdraw the store instead'}
          </Button>
        </div>
      ) : null}
      {rows === undefined ? null : (
        <div className="mt-16 flex flex-col gap-12">
          {dropped > 0 ? (
            <p className="text-13 text-text-3">
              {dropped === 1 ? '1 entry' : `${dropped} entries`} of your last list could not be kept
              (an asset this store does not take, or an address or proof no reader takes).
            </p>
          ) : null}
          {rows.length === 0 ? <p className="text-14 text-text-3">No payouts yet.</p> : null}
          <ul className="flex flex-col gap-8">
            {rows.map((row) => (
              <li
                key={row.caip19}
                data-payout={row.caip19}
                className="border-line flex flex-col gap-4 border-t pt-8"
              >
                <span className="text-14 font-medium">{labelOf(row.caip19)}</span>
                <span className="text-13 font-mono break-all">{row.address}</span>
                <span className="text-12 text-text-3">
                  {row.signature === undefined
                    ? 'not verified by the wallet'
                    : 'verified by the wallet'}
                </span>
                {row.signature === undefined ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void verify(row)}
                    className="self-start"
                  >
                    Verify {labelOf(row.caip19)} with its wallet
                  </Button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRows(rows.filter((other) => other.caip19 !== row.caip19));
                    setSaved(false);
                  }}
                  className="text-13 text-error self-start underline underline-offset-2"
                >
                  Remove {labelOf(row.caip19)}
                </button>
              </li>
            ))}
          </ul>
          <div className="border-line flex flex-col gap-8 border-t pt-12">
            <label htmlFor="payout-asset" className="text-14 font-medium">
              Add a payout
            </label>
            <select
              id="payout-asset"
              value={asset}
              onChange={(event) => setAsset(event.target.value)}
              className="rounded-10 border-line-2 bg-bg text-14 border px-8 py-6"
            >
              <option value="">Paid in...</option>
              {allowedAssets.map((each) => (
                <option key={each.caip19} value={each.caip19}>
                  {each.label}
                </option>
              ))}
            </select>
            <label htmlFor="payout-address" className="text-13 text-text-2">
              Your wallet address
            </label>
            <Input
              id="payout-address"
              type="text"
              value={address}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setAddress(event.target.value)}
              mono
            />
            <div className="flex flex-wrap gap-8">
              <Button disabled={busy} onClick={() => void add()}>
                Prove with my wallet and add
              </Button>
              <Button disabled={busy} onClick={addUnproved}>
                Add without the wallet
              </Button>
            </div>
          </div>
          {railsWait === undefined ? null : (
            <p role="status" className="text-13 text-text-2">
              Turning on {railsWait.rails.map((rail) => RAIL_NAMES[rail] ?? rail).join(', ')} for
              your payouts: they are signed once the store has it.
            </p>
          )}
          {saved ? (
            <p role="status" className="text-13 text-text-2">
              Signed and saved: the payouts go out with the store shortly.
            </p>
          ) : null}
          <Button
            disabled={busy || railsWait !== undefined}
            onClick={() => void sign()}
            variant="primary"
            size="lg"
          >
            Sign and save payouts
          </Button>
        </div>
      )}
      {goesOut === 'waiting' ? (
        <p role="status" className="text-13 text-text-2 mt-12">
          Waiting to go out: the store is applying a change.
        </p>
      ) : null}
      {goesOut === 'launch' ? (
        <p role="status" className="text-13 text-text-2 mt-12">
          Saved: your payouts go out when the store launches.
        </p>
      ) : null}
      {goesOut === 'resume' ? (
        <p role="status" className="text-13 text-text-2 mt-12">
          Saved: your payouts go out when the store is resumed.
        </p>
      ) : null}
      {goesOut === 'live' ? (
        <p role="status" className="text-13 text-text-2 mt-12">
          {liveText}
        </p>
      ) : null}
      {goesOut === 'missing' ? (
        <div role="alert" className="text-13 text-error mt-12 flex flex-col items-start gap-8">
          <p>
            Your payout change did not go out: the relays show another list. Check again in a
            minute; if it stays, contact elisym.
          </p>
          <Button onClick={askRead} size="sm">
            Check again
          </Button>
        </div>
      ) : null}
      {problems.length === 0 ? null : (
        <ul role="alert" className="text-13 text-error mt-12 list-disc pl-20">
          {problems.map((problem, index) => (
            <li key={index}>{problem}</li>
          ))}
        </ul>
      )}
      {notice === '' ? null : (
        <p role="alert" className="text-13 text-error mt-12">
          {notice}
        </p>
      )}
    </Card>
  );
}
