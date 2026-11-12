import {
  CONFIG_D_TAG,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  type StoreConfig,
  parseConfig,
} from '@elisym/askr';
import { type SessionDeps, postSigned } from './deps';
import type { SignedJournal } from './journal';
import { type ServerKeys, type StoreForm, signStoreEvents } from './store-form';
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
  authorized?: ReadonlySet<string>;
}

/** Sign the config (and the source key's authorization when needed) and store it on the server. */
export async function saveSettings(input: SaveInput): Promise<void> {
  const events = await signStoreEvents({
    form: input.form,
    keys: keysOfView(input.view),
    signer: input.deps.signer,
    now: input.deps.now(),
    previousCreatedAt: Math.max(
      input.previousCreatedAt ?? 0,
      input.deps.journal.latest(KIND_CONFIG, CONFIG_D_TAG)?.created_at ?? 0,
    ),
    ...(input.authorized === undefined ? {} : { authorized: input.authorized }),
  });
  await postSigned(input.deps, events);
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

/** What the merchant is told after a save, by store status. */
export function savedMessage(view: Pick<StoreView, 'status'>): string {
  return view.status === 'active'
    ? 'Saved. The new settings are published to the relay in a moment.'
    : 'Saved. Your settings are kept on the server and published once your store is activated.';
}
