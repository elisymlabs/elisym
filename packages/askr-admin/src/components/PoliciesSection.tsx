import {
  LIMITS,
  type Policy,
  SHOPIFY_POLICY_SLUGS,
  type StoreConfig,
  policiesInUse,
} from '@elisym/askr';
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
  // While a Shopify connector is set to import policies, each sync puts the shop's version of
  // these back; one saved but not enabled yet would on its first sync.
  const importedSlugs =
    view.connector?.platform === 'shopify' && view.connector.importPolicies
      ? SHOPIFY_POLICY_SLUGS.map((entry) => entry.slug)
      : [];

  const read = useCallback(async () => {
    if (config === undefined) {
      return;
    }
    try {
      setPolicies(await readPolicies(deps.reader, config.policyKey, deps.now()));
      setReadError('');
    } catch {
      setPolicies(undefined);
      setEditing(undefined);
      setReadError(
        'The policies could not be read, so none can be added or changed until they are. Retry in a moment.',
      );
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
  // The places taken: the policies there, and the ones the import has yet to bring (as the server
  // counts them).
  const taken =
    policies === undefined
      ? 0
      : new Set([...policies.map((policy) => policy.slug), ...importedSlugs]).size;
  // The ones the assistant reads, exactly as the worker picks them, counting the policies the
  // import has yet to bring: they come first, so they may push a store's own ones out.
  const slugsThere = (policies ?? []).map((policy) => policy.slug);
  const inUse = new Set(
    policiesInUse([...new Set([...slugsThere, ...importedSlugs])].map((slug) => ({ slug }))).map(
      (policy) => policy.slug,
    ),
  );
  const unreadCount = slugsThere.filter((slug) => !inUse.has(slug)).length;
  let limitNote = '';
  if (unreadCount > 0) {
    limitNote = `A store has at most ${LIMITS.MAX_POLICIES} policies, counting the ones Shopify imports, so the assistant does not read the ones marked below. ${
      editable
        ? 'Delete the ones it does not need.'
        : 'Remove the ones it does not need where you publish them.'
    }`;
  } else if (editable && taken >= LIMITS.MAX_POLICIES) {
    limitNote = `This store has as many policies as it can have (${LIMITS.MAX_POLICIES}, counting the ones Shopify imports). Delete one to add another.`;
  }
  // A new policy must not reuse a published slug, which only a whole read can tell.
  if (editable && policies !== undefined && editing !== undefined) {
    editor = (
      <PolicyEditor
        key={editing.mode === 'edit' ? editing.policy.slug : 'new'}
        initial={editing.mode === 'edit' ? editing.policy : undefined}
        takenSlugs={policies.map((existing) => existing.slug)}
        importedSlugs={importedSlugs}
        onCancel={() => setEditing(undefined)}
        onSave={async (policy) => {
          await deps.api.putPolicy(policy.slug, { title: policy.title, body: policy.body });
          setEditing(undefined);
          await read();
        }}
      />
    );
  } else if (editable && policies !== undefined && taken < LIMITS.MAX_POLICIES) {
    editor = (
      <div>
        <button type="button" className="btn" onClick={() => setEditing({ mode: 'new' })}>
          Add a policy
        </button>
      </div>
    );
  }

  return (
    <Section
      title="Policies and FAQ"
      description="Shipping, returns, sizing and other answers the assistant may quote."
    >
      {note === '' ? null : <Notice tone="info">{note}</Notice>}
      {editable && importedSlugs.length > 0 ? (
        <Notice tone="info">
          Your Shopify connector is set to import the {importedSlugs.join(', ')} policies, and each
          sync puts the shop&apos;s version back. Change those in Shopify, or turn off policy import
          in Connector to edit them here.
        </Notice>
      ) : null}
      {limitNote === '' ? null : <Notice tone="info">{limitNote}</Notice>}
      {readError === '' ? null : (
        <Notice tone="error">
          {readError}{' '}
          <button type="button" className="underline" onClick={() => void read()}>
            Retry
          </button>
        </Notice>
      )}
      {policies === undefined ? null : (
        <ul className="flex flex-col gap-8">
          {policies.length === 0 ? <li className="text-14 text-text-2">No policies yet.</li> : null}
          {policies.map((policy) => (
            <PolicyRow
              key={policy.slug}
              policy={policy}
              editable={editable && !importedSlugs.includes(policy.slug)}
              imported={importedSlugs.includes(policy.slug)}
              unread={!inUse.has(policy.slug)}
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
