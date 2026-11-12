import type { Policy, StoreConfig } from '@elisym/askr';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { readPolicies } from '../lib/store-data';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { PolicyEditor } from './PolicyEditor';
import { PolicyRow } from './PolicyRow';
import { Section } from './Section';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
}

type Editing = { mode: 'new' } | { mode: 'edit'; policy: Policy } | undefined;

/** Policies and FAQ (30495), published by the server K through the API (2.2). */
export function PoliciesSection({ deps, view, config }: Props) {
  const [policies, setPolicies] = useState<Policy[]>();
  const [readError, setReadError] = useState('');
  const [editing, setEditing] = useState<Editing>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const editable = config !== undefined && config.policyKey === view.catalogKey;

  const read = useCallback(async () => {
    if (config === undefined) {
      return;
    }
    try {
      setPolicies(await readPolicies(deps.reader, config.policyKey, deps.now()));
      setReadError('');
    } catch {
      setReadError('The policies could not be read from the relay.');
    }
  }, [deps, config]);

  useEffect(() => {
    void read();
  }, [read]);

  const remove = async (slug: string) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await deps.api.deletePolicy(slug);
      await read();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  let note = '';
  if (config === undefined) {
    note = 'Policies can be edited once your settings are published.';
  } else if (!editable) {
    note =
      'Your settings read policies from your own catalog key, so publish them from your backend, the SDK or your agent. The editor here writes with the server key.';
  }

  let editor: ReactNode = null;
  if (editable) {
    editor =
      editing === undefined ? (
        <div>
          <button type="button" className="btn" onClick={() => setEditing({ mode: 'new' })}>
            Add a policy
          </button>
        </div>
      ) : (
        <PolicyEditor
          key={editing.mode === 'edit' ? editing.policy.slug : 'new'}
          initial={editing.mode === 'edit' ? editing.policy : undefined}
          onCancel={() => setEditing(undefined)}
          onSave={async (policy) => {
            await deps.api.putPolicy(policy.slug, { title: policy.title, body: policy.body });
            setEditing(undefined);
            await read();
          }}
        />
      );
  }

  return (
    <Section
      title="Policies and FAQ"
      description="Shipping, returns, sizing and other answers the assistant may quote."
    >
      {note === '' ? null : <Notice tone="info">{note}</Notice>}
      {readError === '' ? null : <Notice tone="error">{readError}</Notice>}
      {policies === undefined ? null : (
        <ul className="flex flex-col gap-8">
          {policies.length === 0 ? <li className="text-14 text-text-2">No policies yet.</li> : null}
          {policies.map((policy) => (
            <PolicyRow
              key={policy.slug}
              policy={policy}
              editable={editable}
              busy={busy}
              onEdit={() => setEditing({ mode: 'edit', policy })}
              onDelete={() => remove(policy.slug)}
            />
          ))}
        </ul>
      )}
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      {editor}
    </Section>
  );
}
