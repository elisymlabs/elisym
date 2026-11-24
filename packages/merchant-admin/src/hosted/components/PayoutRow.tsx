import { useState } from 'react';
import { coinLabel } from '../lib/coins';
import { GENERIC_ERROR } from '../lib/errors';
import type { PayoutRowValue } from '../lib/payout-rows';
import type { StoreSession } from '../lib/store-session';
import {
  type ProofErrorCode,
  ProofError,
  type WalletChoice,
  familyOf,
  signPayoutProof,
} from '../lib/wallets';
import { INPUT } from '../styles';
import { Notice } from './Notice';
import { PasteProof } from './PasteProof';
import { WalletPicker } from './WalletPicker';

interface Props {
  index: number;
  row: PayoutRowValue;
  session: StoreSession;
  onChange: (row: PayoutRowValue) => void;
}

export const PROOF_ERRORS: Readonly<Record<ProofErrorCode, string>> = {
  unavailable: 'That wallet cannot sign for this coin. Choose another wallet.',
  rejected: 'The wallet did not sign. Try again and approve the request in your wallet.',
  wrong_address:
    'The wallet signed with another address than the one entered. Switch the wallet to that address, or clear the field to use the wallet address.',
  bad_signature: 'The wallet signature does not prove this address. Try again.',
  no_account: 'The wallet has no account to sign with. Unlock it or add an account, then retry.',
};

/** One coin's payout address and its wallet proof (A5). */
export function PayoutRow({ index, row, session, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const family = familyOf(row.caip19);
  const label = coinLabel(row.caip19) ?? row.caip19;
  const address = row.address.trim();

  const prove = (provenAddress: string, signature: string) => {
    session.proven.add(row.caip19, provenAddress);
    setProblem(undefined);
    onChange({ caip19: row.caip19, address: provenAddress, signature });
  };

  const sign = async (wallet: WalletChoice) => {
    setBusy(true);
    setProblem(undefined);
    try {
      const proof = await signPayoutProof({
        wallet,
        ownerPubkey: session.owner,
        caip19: row.caip19,
        ...(address === '' ? {} : { expectedAddress: address }),
      });
      prove(proof.address, proof.signature);
    } catch (error) {
      setProblem(error instanceof ProofError ? PROOF_ERRORS[error.code] : GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  };

  let state: string;
  if (address === '') {
    state = 'Not used';
  } else if (row.signature === undefined) {
    state = 'Not signed yet';
  } else if (session.proven.has(row.caip19, address)) {
    state = 'Signed from this device';
  } else {
    state = 'Signed earlier';
  }

  return (
    <li className="border-line flex flex-col gap-8 border-b pb-16">
      <label className="text-14 flex flex-col gap-4">
        <span className="font-medium">{label}</span>
        <input
          id={`payout-address-${index}`}
          className={INPUT}
          value={row.address}
          placeholder="Payout address, or sign with a wallet"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => onChange({ caip19: row.caip19, address: event.target.value })}
        />
      </label>
      <p className="text-13 text-text-2" id={`payout-state-${index}`}>
        {state}
      </p>
      {family === undefined ? null : (
        <WalletPicker family={family} disabled={busy} onPick={(wallet) => void sign(wallet)} />
      )}
      {family === 'evm' ? (
        <PasteProof
          index={index}
          owner={session.owner}
          caip19={row.caip19}
          address={row.address}
          onProven={prove}
        />
      ) : null}
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </li>
  );
}
