import { useEffect, useRef, useState } from 'react';
import { currentPayouts, newKeyProblem, runMove } from '../lib/move-flow';
import { forgetKey, rememberKey } from '../lib/remembered';
import { type Signer, secretKeySigner } from '../lib/signer';
import type { StoreSession } from '../lib/store-session';
import type { MoveInput, Payout, StoreView } from '../lib/types';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_TEXT } from '../styles';
import { MoveDone } from './MoveDone';
import { MoveKeyChoice } from './MoveKeyChoice';
import { MovePayoutRow } from './MovePayoutRow';
import { MoveWarnings, namesOwnerOnDomain } from './MoveWarnings';
import { Notice } from './Notice';
import type { RememberHandle } from './RememberOption';

interface Props {
  session: StoreSession;
  view: StoreView;
}

export const MOVE_EXPLAINED =
  'Move this store to a new owner key, for example when the current one may have been seen by someone else. Your store, products, orders and payouts stay; only the key that owns them changes. Both keys sign the move, and each payout wallet signs again for the new key.';
export const MOVE_SWITCHING =
  'Your store is switching to this owner key. It can move again once that is done.';
export const MOVE_NO_PAYOUTS =
  'Your store has no payouts yet, so it cannot move. Add them in Payouts first.';
export const SIGN_EACH = 'Sign each payout address with its wallet for the new key.';
export const UNDERSTOOD = 'I read what changes, and I want to move my store';
export const MOVED_DONE = 'PayCore now publishes your store under the new owner key.';
export const MOVED_ON_ACTIVATION =
  'Your store is on the new owner key. It goes live under that key when PayCore activates it.';
export const MOVED_FOLLOWING =
  'PayCore is publishing your store under the new owner key. Until that is done, it keeps selling on its previous payout list.';
export const NOT_REMEMBERED =
  'The new key could not be remembered on this device. To go on without it, clear the remember box and try again.';

/** The new owner key while the move is made: a signer, and a copy of its bytes to remember it. */
interface HeldKey {
  signer: Signer;
  secretKey: Uint8Array;
}

type Stage =
  | { kind: 'intro' }
  | { kind: 'key' }
  | { kind: 'sign'; to: string }
  | {
      kind: 'moved';
      to: string;
      message: string;
      tone: 'info' | 'error';
      requestId: string | undefined;
      domainUpdate: boolean;
    };

function payoutKey(payout: Pick<Payout, 'caip19' | 'address'>): string {
  return `${payout.caip19}\n${payout.address}`;
}

function release(held: HeldKey | undefined): void {
  held?.signer.close();
  held?.secretKey.fill(0);
}

/**
 * Move the store to a new owner key O' (shown only when the server allows
 * moves): choose O', sign every active payout again for it, read what
 * changes, then prepare and sign with both keys. Once moved, the device
 * forgets O, offers to remember O', and the page goes on as O'.
 */
export function MoveStore({ session, view }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'intro' });
  const [signatures, setSignatures] = useState<ReadonlyMap<string, string>>(new Map());
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const held = useRef<HeldKey | undefined>(undefined);
  /** A move sent whose answer was lost: the next try sends it again as it is. */
  const sent = useRef<MoveInput | undefined>(undefined);
  const running = useRef(false);
  const remember = useRef<RememberHandle>(null);

  // The new key never outlives this screen unless the page goes on with it.
  useEffect(
    () => () => {
      release(held.current);
      held.current = undefined;
    },
    [],
  );

  if (!session.meta.storeMoves || view.status === 'suspending' || view.status === 'suspended') {
    return null;
  }

  const payouts = currentPayouts(view);

  const restart = () => {
    sent.current = undefined;
    release(held.current);
    held.current = undefined;
    setSignatures(new Map());
    setUnderstood(false);
    setProblem(undefined);
    setStage({ kind: 'intro' });
  };

  // Reached only from the key step, which only `restart` opens: a held move is already dropped.
  const chooseKey = (secretKey: Uint8Array) => {
    release(held.current);
    const signer = secretKeySigner(secretKey);
    held.current = { signer, secretKey: Uint8Array.from(secretKey) };
    setSignatures(new Map());
    setUnderstood(false);
    setProblem(undefined);
    setStage({ kind: 'sign', to: signer.pubkey });
  };

  const move = async () => {
    const key = held.current;
    if (key === undefined || running.current) {
      return;
    }
    const proven: Payout[] = [];
    for (const payout of payouts) {
      const signature = signatures.get(payoutKey(payout));
      if (signature === undefined) {
        setProblem(SIGN_EACH);
        return;
      }
      proven.push({ caip19: payout.caip19, address: payout.address, signature });
    }
    running.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await runMove({
        api: session.api,
        view,
        payouts: proven,
        operator: session.operator,
        localNow: session.localNow,
        signOld: session.signEvent,
        newOwner: key.signer,
        ...(sent.current === undefined ? {} : { sent: sent.current }),
      });
      sent.current = result.ok ? undefined : result.sent;
      if (!result.ok) {
        setProblem(result.message);
        return;
      }
      // The previous key can never open a store again: nothing of it stays on this device.
      forgetKey(view.owner);
      const { outcome } = result;
      let message = MOVED_DONE;
      if (outcome.kind === 'on_activation') {
        message = MOVED_ON_ACTIVATION;
      } else if (outcome.kind === 'follow') {
        message = MOVED_FOLLOWING;
      } else if (outcome.kind === 'failed') {
        message = outcome.message;
      }
      setStage({
        kind: 'moved',
        to: key.signer.pubkey,
        message,
        tone: outcome.kind === 'failed' ? 'error' : 'info',
        requestId: outcome.kind === 'follow' ? outcome.requestId : undefined,
        domainUpdate: namesOwnerOnDomain(view),
      });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const continueAsNew = async (requestId: string | undefined) => {
    const key = held.current;
    if (key === undefined || running.current) {
      return;
    }
    running.current = true;
    try {
      if (remember.current?.read().kind === 'on') {
        setBusy(true);
        setProblem(undefined);
        if (!(await rememberKey(key.secretKey))) {
          setProblem(NOT_REMEMBERED);
          return;
        }
      }
      key.secretKey.fill(0);
      held.current = undefined;
      session.switchOwner({ signer: key.signer, requestId });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  let body;
  if (view.switching === true) {
    body = <p className="text-14 text-text-2">{MOVE_SWITCHING}</p>;
  } else if (stage.kind === 'moved') {
    const { requestId } = stage;
    body = (
      <MoveDone
        view={view}
        newOwner={stage.to}
        message={stage.message}
        tone={stage.tone}
        domainUpdate={stage.domainUpdate}
        rememberRef={remember}
        busy={busy}
        problem={problem}
        onContinue={() => void continueAsNew(requestId)}
      />
    );
  } else if (payouts.length === 0) {
    body = <p className="text-14 text-text-2">{MOVE_NO_PAYOUTS}</p>;
  } else if (stage.kind === 'intro') {
    body = (
      <div className="flex flex-col gap-8">
        <p className="text-14 text-text-2">{MOVE_EXPLAINED}</p>
        <div>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            onClick={() => setStage({ kind: 'key' })}
          >
            Move to a new owner key
          </button>
        </div>
      </div>
    );
  } else if (stage.kind === 'key') {
    body = (
      <MoveKeyChoice
        check={(pubkey) => newKeyProblem(pubkey, view)}
        onKey={chooseKey}
        onCancel={restart}
      />
    );
  } else {
    const { to } = stage;
    const allSigned = payouts.every((payout) => signatures.has(payoutKey(payout)));
    body = (
      <div className="flex flex-col gap-16">
        <div className="flex flex-col gap-4">
          <h3 className="text-15 font-semibold">Sign your payouts for the new key</h3>
          <p className="text-13 text-text-2">
            Each payout wallet signs that it belongs to the new owner key. The addresses stay as
            they are.
          </p>
        </div>
        <ul className="flex flex-col gap-16">
          {payouts.map((payout, index) => (
            <MovePayoutRow
              key={payoutKey(payout)}
              index={index}
              payout={payout}
              newOwner={to}
              signature={signatures.get(payoutKey(payout))}
              onSigned={(signature) =>
                setSignatures((current) => new Map(current).set(payoutKey(payout), signature))
              }
            />
          ))}
        </ul>
        <MoveWarnings view={view} />
        <label className="text-14 flex items-center gap-8">
          <input
            id="move-understood"
            type="checkbox"
            checked={understood}
            onChange={(event) => setUnderstood(event.target.checked)}
          />
          {UNDERSTOOD}
        </label>
        {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
        <button
          type="button"
          className={BUTTON_PRIMARY}
          disabled={busy || !understood || !allSigned}
          onClick={() => void move()}
        >
          {busy ? 'Moving your store...' : 'Move store'}
        </button>
        <div>
          <button type="button" className={BUTTON_TEXT} disabled={busy} onClick={restart}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-8" aria-labelledby="move-heading">
      <h2 id="move-heading" className="text-16 font-semibold">
        Move store
      </h2>
      {body}
    </section>
  );
}
