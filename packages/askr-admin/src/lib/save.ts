import {
  CONFIG_D_TAG,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  type StoreConfig,
  parseConfig,
} from '@elisym/askr';
import { PENDING_CONTACT_TEXT } from './activation';
import { type SessionDeps, postSigned } from './deps';
import { errorMessage } from './errors';
import type { SignedJournal } from './journal';
import {
  type ServerKeys,
  type StoreForm,
  authorizationOf,
  connectorOf,
  signStoreEvents,
} from './store-form';
import type { StoreView } from './types';

/** The assistant a new config names: the next A while a rotation is under way (1.5). */
export function keysOfView(
  view: Pick<StoreView, 'assistant' | 'nextAssistant' | 'catalogKey'>,
): ServerKeys {
  return { assistant: view.nextAssistant ?? view.assistant, serverKey: view.catalogKey };
}

export interface SaveInput {
  deps: SessionDeps;
  view: StoreView;
  form: StoreForm;
  previousCreatedAt?: number;
  /** Catalog keys the relay shows the owner authorizes now. */
  authorized?: ReadonlySet<string>;
  /** The newest 30497 per key on the relay, so a new one is dated after it. */
  relayNewestAt?: ReadonlyMap<string, number>;
}

/** Whether this session's newest 30497 for `key` revokes it. */
function revokedHere(journal: SignedJournal, key: string): boolean {
  return (
    journal
      .latest(KIND_CATALOG_AUTH, key)
      ?.tags.some((tag) => tag[0] === 'mode' && tag[1] === 'revoked') === true
  );
}

/** Keys authorized on the relay, less those this session revoked since. */
export function authorizedNow(relay: ReadonlySet<string>, journal: SignedJournal): Set<string> {
  return new Set([...relay].filter((key) => !revokedHere(journal, key)));
}

/** Sign the config (and the source key's authorization when needed) and store it on the server. */
/** What a save did beyond the settings, for the merchant. */
export interface SaveOutcome {
  /** Syncing paused or the connector removed by this save. */
  note?: string;
  /** The settings are saved, but the connector step failed: a save again retries it. */
  connectorError?: string;
}

export async function saveSettings(input: SaveInput): Promise<SaveOutcome> {
  const { journal } = input.deps;
  const now = input.deps.now();
  // Checked before anything is signed: a bad feed address must not leave half a save.
  const connector = connectorOf(input.form);
  const authKey = authorizationOf(input.form, input.view.catalogKey).key;
  const events = await signStoreEvents({
    form: input.form,
    keys: keysOfView(input.view),
    signer: input.deps.signer,
    now,
    previousCreatedAt: Math.max(
      input.previousCreatedAt ?? 0,
      input.deps.journal.latest(KIND_CONFIG, CONFIG_D_TAG)?.created_at ?? 0,
    ),
    ...(input.authorized === undefined
      ? {}
      : { authorized: authorizedNow(input.authorized, journal) }),
    authCreatedAt: nextAuthDate(authKey, now, input.relayNewestAt, journal),
  });
  await postSigned(input.deps, events);
  return connectorStep(input, connector);
}

/** The connector follows the settings it is part of: set up with them, gone with them. */
async function connectorStep(
  input: SaveInput,
  connector: ReturnType<typeof connectorOf>,
): Promise<SaveOutcome> {
  const before = input.view.connector;
  try {
    if (connector !== undefined) {
      const { connector: after } = await input.deps.api.putConnector(connector);
      return before?.enabled === true && after?.enabled === false
        ? {
            note: 'Syncing is paused, since the shop changed: turn it on again in the Connector tab.',
          }
        : {};
    }
    if (before !== null) {
      await input.deps.api.deleteConnector();
      return {
        note: 'The connector is removed: your products no longer sync. Products already published stay until you change them.',
      };
    }
    return {};
  } catch (failure) {
    return {
      connectorError: `Your settings are saved, but the connector could not be updated: ${errorMessage(failure)} Save again to retry.`,
    };
  }
}

/**
 * The config to edit: the relay's, or the one this session signed after it,
 * which the server stored but has not published yet.
 */
export function newestConfig(
  relay: StoreConfig | undefined,
  journal: SignedJournal,
): StoreConfig | undefined {
  const signed = journal.latest(KIND_CONFIG, CONFIG_D_TAG);
  const local = signed === undefined ? undefined : parseConfig(signed);
  if (local === undefined) {
    return relay;
  }
  return relay === undefined || local.createdAt > relay.createdAt ? local : relay;
}

/**
 * The date of a new 30497 for `key`: now, or just after the newest one for
 * that key on the relay or signed in this session, so the new one wins.
 */
export function nextAuthDate(
  key: string,
  now: number,
  relayNewestAt: ReadonlyMap<string, number> | undefined,
  journal: SignedJournal,
): number {
  const relay = relayNewestAt?.get(key) ?? 0;
  const local = journal.latest(KIND_CATALOG_AUTH, key)?.created_at ?? 0;
  return Math.max(now, relay + 1, local + 1);
}

/**
 * What the merchant is told after a save, by store status. Saving never
 * activates a store (6.2): a pending store without a plan is told to choose
 * one, and one the operator set back to pending (it keeps its tier) is told to
 * message us.
 */
export function savedMessage(view: Pick<StoreView, 'status' | 'tier'>): string {
  if (view.status === 'active') {
    return 'Saved. The new settings are published in a moment.';
  }
  if (view.status === 'suspended') {
    return 'Saved. Your settings are kept on the server and published once your store is reactivated.';
  }
  return view.tier === null
    ? 'Saved. Choose a plan in Billing to go live.'
    : `Saved. ${PENDING_CONTACT_TEXT}`;
}
