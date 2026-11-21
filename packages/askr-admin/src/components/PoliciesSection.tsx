import {
  LIMITS,
  type Policy,
  SHOPIFY_POLICY_SLUGS,
  type StoreConfig,
  policiesInUse,
} from '@elisym/askr';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { SYNC_POLL_MS } from '../constants';
import { Pause, type Settled, whileSettingUp } from '../lib/catalog-writer';
import type { SessionDeps } from '../lib/deps';
import { errorMessage } from '../lib/errors';
import { HELP } from '../lib/help';
import { readPolicies } from '../lib/store-data';
import type { StoreView } from '../lib/types';
import { NeedsActiveStore } from './NeedsActiveStore';
import { Notice } from './Notice';
import { PolicyEditor } from './PolicyEditor';
import { PolicyRow } from './PolicyRow';
import { Section } from './Section';

interface Props {
  deps: SessionDeps;
  view: StoreView;
  config: StoreConfig | undefined;
  /** Opens Overview, where a store with no plan chooses one. */
  onChoosePlan?: () => void;
  /** Between two saves refused while the store is set up; tests pass a short one. */
  pollMs?: number;
}

type Editing = { mode: 'new' } | { mode: 'edit'; policy: Policy } | undefined;

/** Policies and FAQ (30495), published by the server K through the API (2.2). */
export function PoliciesSection({
  deps,
  view,
  config,
  onChoosePlan,
  pollMs = SYNC_POLL_MS,
}: Props) {
  const [policies, setPolicies] = useState<Policy[]>();
  const [readError, setReadError] = useState('');
  const [editing, setEditing] = useState<Editing>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** A save waiting for the store to be set up: Cancel and leaving the page end it. */
  const saving = useRef<Pause | undefined>(undefined);
  /** Where a save stands: a request in flight cannot be taken back, a setting-up wait can. */
  const [savePhase, setSavePhase] = useState<'idle' | 'sending' | 'waiting'>('idle');
  useEffect(() => () => saving.current?.stop(), []);
  const active = view.status === 'active';
  // Written with the server key, which publishes only for an active store.
  const serverKeyed = config !== undefined && config.policyKey === view.catalogKey;
  const editable = serverKeyed && active;
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

  // A save waits only while its editor is on the page: once it is gone (the policies can no longer
  // be edited here, or were read again and failed), the wait ends and nothing more is sent.
  const editorShown = editable && policies !== undefined && editing !== undefined;
  useEffect(() => {
    if (!editorShown) {
      saving.current?.stop();
    }
  }, [editorShown]);

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
  } else if (!serverKeyed) {
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
  if (editorShown && editing !== undefined) {
    editor = (
      <PolicyEditor
        key={editing.mode === 'edit' ? editing.policy.slug : 'new'}
        initial={editing.mode === 'edit' ? editing.policy : undefined}
        takenSlugs={policies.map((existing) => existing.slug)}
        importedSlugs={importedSlugs}
        cancelDisabled={savePhase === 'sending'}
        {...(savePhase === 'waiting'
          ? { status: 'Your store is being set up, your change goes out in a moment.' }
          : {})}
        onCancel={() => {
          saving.current?.stop();
          setEditing(undefined);
        }}
        onSave={async (policy) => {
          const pause = new Pause();
          saving.current = pause;
          // Right after a plan is chosen the relay may refuse the server key for a moment.
          let settled: Settled<{ id: string }>;
          try {
            settled = await whileSettingUp({
              attempt: () => {
                setSavePhase('sending');
                return deps.api.putPolicy(policy.slug, { title: policy.title, body: policy.body });
              },
              refusal: 'publish_refused',
              store: () => deps.api.store(),
              sleep: (ms) => pause.sleep(ms),
              cancelled: () => pause.stopped,
              onWait: () => setSavePhase('waiting'),
              pollMs,
            });
          } finally {
            setSavePhase('idle');
          }
          if (settled.kind === 'cancelled') {
            return;
          }
          setEditing(undefined);
          await read();
        }}
      />
    );
  }
  const addButton =
    editable && policies !== undefined && editing === undefined && taken < LIMITS.MAX_POLICIES ? (
      <button type="button" className="btn btn-primary" onClick={() => setEditing({ mode: 'new' })}>
        Add a policy
      </button>
    ) : undefined;

  return (
    <div className="flex flex-col gap-32">
      <NeedsActiveStore
        view={view}
        noun="add policies"
        {...(onChoosePlan === undefined ? {} : { onChoosePlan })}
      />
      {note === '' ? null : <Notice tone="info">{note}</Notice>}
      {editable && importedSlugs.length > 0 ? (
        <Notice tone="info">
          Your Shopify connector is set to import the {importedSlugs.join(', ')} policies, and each
          sync puts the shop&apos;s version back. Change those in Shopify, or turn off policy import
          in Settings to edit them here.
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
      {error === '' ? null : <Notice tone="error">{error}</Notice>}
      {editor}
      <Section
        title="Policies and FAQ"
        info={HELP.policies}
        description="Shipping, returns, sizing and other answers the assistant may quote."
        actions={addButton}
        flush
      >
        {policies === undefined ? (
          <p className="text-14 text-text-2 px-20 py-16">
            {readError === '' ? 'Reading your policies...' : 'Your policies are not read yet.'}
          </p>
        ) : (
          <ul className="rows flex flex-col">
            {policies.length === 0 ? (
              <li className="flex flex-col items-center gap-4 px-20 py-40 text-center">
                <span className="text-14 font-medium">No policies yet.</span>
                <span className="text-13 text-text-2">
                  Add your shipping, returns and other answers shoppers ask about.
                </span>
              </li>
            ) : null}
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
      </Section>
    </div>
  );
}
