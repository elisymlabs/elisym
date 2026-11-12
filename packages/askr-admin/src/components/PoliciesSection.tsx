import type { Policy, StoreConfig } from '@elisym/askr';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { readPolicies } from '../lib/store-data';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';
import { PolicyEditor } from './PolicyEditor';
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
  const editable = config !== undefined && config.policyKey === view.catalogKey;

  const read = useCallback(async () => {
    if (config === undefined) {
      return;
    }
    try {
      setPolicies(await readPolicies(deps.reader, config.policyKey));
      setReadError('');
    } catch {
      setReadError('The policies could not be read from the relay.');
    }
  }, [deps, config]);

  useEffect(() => {
    void read();
  }, [read]);

  const remove = async (slug: string) => {
    setError('');
    try {
      await deps.api.deletePolicy(slug);
      await read();
    } catch (failure) {
      setError(errorMessage(failure));
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
            <li
              key={policy.slug}
              className="border-line rounded-10 flex flex-wrap items-center justify-between gap-8 border p-12"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-14 font-medium">{policy.title}</span>
                <span className="text-12 text-text-3 font-mono">{policy.slug}</span>
              </div>
              {editable ? (
                <div className="flex gap-4">
                  <button
                    type="button"
                    className="btn text-13"
                    onClick={() => setEditing({ mode: 'edit', policy })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger text-13"
                    onClick={() => void remove(policy.slug)}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      {editor}
    </Section>
  );
}
