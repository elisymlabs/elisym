import { useState } from 'react';
import { errorMessage } from '../lib/errors';
import type { StoreSession } from '../lib/store-session';
import type { Network, StoreView } from '../lib/types';
import { BUTTON_SECONDARY, INPUT } from '../styles';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  onCreated: (view: StoreView) => void;
}

const NETWORKS: readonly { id: Network; label: string }[] = [
  { id: 'mainnet', label: 'Mainnet: real payments' },
  { id: 'devnet', label: 'Devnet: test payments only' },
];

export const NAME_REQUIRED = 'Enter a name for your store.';

/** The first step: the store's name, its network (fixed once created) and an optional nip05. */
export function CreateStore({ session, onCreated }: Props) {
  const offered = NETWORKS.filter((network) => session.meta.networks[network.id] !== undefined);
  const [name, setName] = useState('');
  const [network, setNetwork] = useState<Network | undefined>(offered[0]?.id);
  const [nip05, setNip05] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setProblem(NAME_REQUIRED);
      return;
    }
    if (network === undefined) {
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const address = nip05.trim();
      onCreated(
        await session.api.createStore({
          name: trimmed,
          network,
          ...(address === '' ? {} : { nip05: address }),
        }),
      );
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-16">
      <label className="text-14 flex flex-col gap-4">
        Store name
        <input
          id="onboard-name"
          className={INPUT}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <fieldset className="flex flex-col gap-8">
        <legend className="text-14 mb-4 font-medium">Network (cannot be changed later)</legend>
        {offered.map((option) => (
          <label key={option.id} className="text-14 flex items-center gap-8">
            <input
              type="radio"
              name="onboard-network"
              id={`onboard-network-${option.id}`}
              checked={network === option.id}
              onChange={() => setNetwork(option.id)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <label className="text-14 flex flex-col gap-4">
        Store address (nip05, optional)
        <input
          id="onboard-nip05"
          className={INPUT}
          value={nip05}
          placeholder="shop@example.com"
          onChange={(event) => setNip05(event.target.value)}
        />
      </label>
      <div>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          disabled={busy || network === undefined}
          onClick={() => void create()}
        >
          Create store
        </button>
      </div>
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
    </div>
  );
}
