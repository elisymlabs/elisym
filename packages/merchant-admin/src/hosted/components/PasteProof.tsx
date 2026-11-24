import { useState } from 'react';
import { checkPastedProof, proofMessage } from '../lib/wallets';
import { BUTTON_SECONDARY, INPUT } from '../styles';
import { Notice } from './Notice';

interface Props {
  /** Names the element ids. */
  index: number;
  owner: string;
  caip19: string;
  address: string;
  onProven: (address: string, signature: string) => void;
}

export const PASTE_REFUSED =
  'That signature does not prove this address for your owner key and this coin. Sign the exact message above with the payout address.';
export const PASTE_NO_ADDRESS = 'Enter the payout address first.';

/**
 * EVM only (A5): sign the exact message with any EIP-191 tool (`personal_sign`)
 * and paste the signature; the page checks it itself before it takes it.
 */
export function PasteProof({ index, owner, caip19, address, onProven }: Props) {
  const [signature, setSignature] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const check = () => {
    const trimmedAddress = address.trim();
    const trimmed = signature.trim();
    if (trimmedAddress === '') {
      setProblem(PASTE_NO_ADDRESS);
      return;
    }
    if (
      !checkPastedProof({ ownerPubkey: owner, caip19, address: trimmedAddress, signature: trimmed })
    ) {
      setProblem(PASTE_REFUSED);
      return;
    }
    setProblem(undefined);
    setSignature('');
    onProven(trimmedAddress, trimmed);
  };

  return (
    <details className="text-13 flex flex-col gap-8">
      <summary className="cursor-pointer">Or paste a signature made elsewhere</summary>
      <p className="text-text-2 mt-8">Sign exactly this message with the payout address:</p>
      <code
        className="bg-surface-2 rounded-10 block px-12 py-8 font-mono break-all"
        id={`proof-message-${index}`}
      >
        {proofMessage(owner, caip19)}
      </code>
      <label className="mt-8 flex flex-col gap-4">
        Signature
        <input
          id={`paste-signature-${index}`}
          className={INPUT}
          value={signature}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setSignature(event.target.value)}
        />
      </label>
      <div className="mt-8">
        <button type="button" className={BUTTON_SECONDARY} onClick={check}>
          Check signature
        </button>
      </div>
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </details>
  );
}
