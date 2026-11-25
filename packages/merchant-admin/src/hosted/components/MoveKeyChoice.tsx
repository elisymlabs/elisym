import { useEffect, useRef, useState } from 'react';
import { type OwnerKey, generateOwnerKey, parseSecretKey, publicKeyOf } from '../lib/signer';
import { BUTTON_SECONDARY, BUTTON_TEXT, KEY_INPUT } from '../styles';
import { NewOwnerKeyCard } from './NewOwnerKeyCard';
import { Notice } from './Notice';

interface Props {
  /** Why this key cannot be the new owner key (its public key, hex), or undefined. */
  check: (pubkey: string) => string | undefined;
  /** The new owner key, chosen: the callee keeps its own copy, these bytes are zeroed after. */
  onKey: (secretKey: Uint8Array) => void;
  onCancel: () => void;
}

export const NOT_A_KEY = 'That is not an owner key: paste an nsec or 64 hex characters.';
export const MOVE_KEY_INTRO =
  'Your store moves to this key: from then on it is the only key that signs in to the store and signs its payout addresses. Keep it like a password. Anyone who has it controls your store, and nobody can recover it for you. It is shown only once.';

/** The new owner key: paste one, or make one here and save it first. */
export function MoveKeyChoice({ check, onKey, onCancel }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [generated, setGenerated] = useState<OwnerKey | undefined>(undefined);
  // The made key for the cleanups below, which run outside a render.
  const made = useRef<OwnerKey | undefined>(undefined);
  made.current = generated;

  // Leaving the page keeps it in the back/forward cache: a typed or made key must not come back.
  useEffect(() => {
    const clear = () => {
      if (input.current !== null) {
        input.current.value = '';
      }
      made.current?.secretKey.fill(0);
      setGenerated(undefined);
    };
    window.addEventListener('pagehide', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      // Leaving the step any other way (another tab, the move closed) zeroes the made key too.
      made.current?.secretKey.fill(0);
    };
  }, []);

  const take = (secretKey: Uint8Array): boolean => {
    const pubkey = publicKeyOf(secretKey);
    const refused = pubkey === undefined ? NOT_A_KEY : check(pubkey);
    if (refused !== undefined) {
      setProblem(refused);
      return false;
    }
    setProblem(undefined);
    onKey(secretKey);
    return true;
  };

  const takePasted = () => {
    const field = input.current;
    if (field === null) {
      return;
    }
    const secretKey = parseSecretKey(field.value);
    field.value = '';
    if (secretKey === undefined) {
      setProblem(NOT_A_KEY);
      return;
    }
    take(secretKey);
    secretKey.fill(0);
  };

  if (generated !== undefined) {
    return (
      <NewOwnerKeyCard
        header={
          <div className="flex flex-col gap-8">
            <h3 className="text-15 font-semibold">Save your new owner key</h3>
            <p className="text-14 text-text-2 leading-relaxed">{MOVE_KEY_INTRO}</p>
          </div>
        }
        nsec={generated.nsec}
        npub={generated.npub}
        onContinue={() => {
          if (take(generated.secretKey)) {
            generated.secretKey.fill(0);
          }
        }}
        onCancel={() => {
          generated.secretKey.fill(0);
          setGenerated(undefined);
        }}
      >
        {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
      </NewOwnerKeyCard>
    );
  }
  return (
    <div className="flex flex-col gap-12">
      <label htmlFor="move-new-key" className="text-14 font-medium">
        New owner key
      </label>
      <input
        id="move-new-key"
        ref={input}
        className={KEY_INPUT}
        type="text"
        placeholder="nsec1... or 64 hex characters"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <div className="flex flex-wrap gap-8">
        <button type="button" className={BUTTON_SECONDARY} onClick={takePasted}>
          Use this key
        </button>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          onClick={() => {
            setProblem(undefined);
            setGenerated(generateOwnerKey());
          }}
        >
          Create a new owner key
        </button>
      </div>
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
      <div>
        <button type="button" className={BUTTON_TEXT} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
