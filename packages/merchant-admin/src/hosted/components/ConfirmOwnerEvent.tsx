import { useState } from 'react';
import { coinLabel } from '../lib/coins';
import { KIND_PAYOUT_LIST } from '../lib/owner-event-check';
import type { Checked } from '../lib/owner-flow';
import type { ProvenPayouts } from '../lib/proven';
import { npubOf } from '../lib/signer';
import { BUTTON_SECONDARY } from '../styles';

interface Props {
  checked: Checked;
  storePubkey: string;
  operator: string;
  proven: ProvenPayouts;
  busy: boolean;
  onSign: () => void;
  onCancel: () => void;
}

/**
 * What O is about to sign (A13). A payout list shows every address in full:
 * those proven in this browser session are marked, each other one needs a
 * tick, since a breached server could propose its own wallet with a valid
 * proof. An authorization says what it lets the store key do.
 */
export function ConfirmOwnerEvent({
  checked,
  storePubkey,
  operator,
  proven,
  busy,
  onSign,
  onCancel,
}: Props) {
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const payoutList = checked.template.kind === KIND_PAYOUT_LIST;
  const unproven = checked.accept
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !proven.has(line.caip19, line.address));
  const ready = unproven.every(({ index }) => ticked.has(index));

  const toggle = (index: number) => {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  return (
    <div
      className="rounded-10 border-line-2 flex flex-col gap-12 border p-16"
      id="confirm-owner-event"
    >
      {payoutList ? (
        <>
          <p className="text-14">
            Buyers will pay to exactly these addresses. Check each one is yours before you sign.
          </p>
          <ul className="flex flex-col gap-10">
            {checked.accept.map((line, index) => (
              <li key={`${line.caip19}:${line.address}`} className="flex flex-col gap-4">
                <span className="text-13 text-text-2">{coinLabel(line.caip19) ?? line.caip19}</span>
                <span className="text-14 font-mono break-all" id={`confirm-address-${index}`}>
                  {line.address}
                </span>
                {proven.has(line.caip19, line.address) ? (
                  <span className="text-13 text-text-2">Signed from this device</span>
                ) : (
                  <label className="text-13 flex items-center gap-8">
                    <input
                      type="checkbox"
                      id={`confirm-tick-${index}`}
                      checked={ticked.has(index)}
                      onChange={() => toggle(index)}
                    />
                    Not signed from this device: I checked this address is mine
                  </label>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="text-14">
            This authorizes {operator} to run your store with its store key (
            <span className="font-mono break-all">{npubOf(storePubkey)}</span>): it publishes your
            products and store profile, takes orders and tells your webhook.
          </p>
          <p className="text-14">
            It cannot move your money or change where buyers pay: payments go straight to your
            payout addresses, and only your owner key signs those.
          </p>
        </>
      )}
      <div className="flex gap-8">
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={busy || !ready}
          onClick={onSign}
        >
          Sign and publish
        </button>
        <button type="button" className={BUTTON_SECONDARY} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
