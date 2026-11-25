import { useState } from 'react';
import { coinLabel } from '../lib/coins';
import { GENERIC_ERROR } from '../lib/errors';
import type { Payout } from '../lib/types';
import { ProofError, type WalletChoice, familyOf, signPayoutProof } from '../lib/wallets';
import { Notice } from './Notice';
import { PasteProof } from './PasteProof';
import { PROOF_ERRORS } from './PayoutRow';
import { WalletPicker } from './WalletPicker';

interface Props {
  /** Names the element ids. */
  index: number;
  /** An active payout: its address stays as it is. */
  payout: Payout;
  /** The new owner key O', hex: what the wallet signs for. */
  newOwner: string;
  /** The wallet signature for O', once made. */
  signature: string | undefined;
  onSigned: (signature: string) => void;
}

/** One active payout, signed again by its wallet for the new owner key. */
export function MovePayoutRow({ index, payout, newOwner, signature, onSigned }: Props) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const family = familyOf(payout.caip19);
  const label = coinLabel(payout.caip19) ?? payout.caip19;

  const sign = async (wallet: WalletChoice) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const proof = await signPayoutProof({
        wallet,
        ownerPubkey: newOwner,
        caip19: payout.caip19,
        expectedAddress: payout.address,
      });
      onSigned(proof.signature);
    } catch (error) {
      setProblem(error instanceof ProofError ? PROOF_ERRORS[error.code] : GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-line flex flex-col gap-8 border-b pb-16">
      <p className="text-14 flex flex-col gap-4">
        <span className="font-medium">{label}</span>
        <span className="font-mono break-all">{payout.address}</span>
      </p>
      <p className="text-13 text-text-2" id={`move-payout-state-${index}`}>
        {signature === undefined ? 'Not signed for the new key yet' : 'Signed for the new key'}
      </p>
      {family === undefined ? null : (
        <WalletPicker family={family} disabled={busy} onPick={(wallet) => void sign(wallet)} />
      )}
      {family === 'evm' ? (
        <PasteProof
          index={index}
          owner={newOwner}
          caip19={payout.caip19}
          address={payout.address}
          onProven={(_address, proven) => {
            setProblem(undefined);
            onSigned(proven);
          }}
        />
      ) : null}
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </li>
  );
}
