import type { SessionDeps } from './deps';
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
    ...(input.previousCreatedAt === undefined
      ? {}
      : { previousCreatedAt: input.previousCreatedAt }),
    ...(input.authorized === undefined ? {} : { authorized: input.authorized }),
  });
  await input.deps.api.storeEvents(events);
}

/** What the merchant is told after a save, by store status. */
export function savedMessage(view: Pick<StoreView, 'status'>): string {
  return view.status === 'active'
    ? 'Saved. The new settings are published to the relay in a moment.'
    : 'Saved. Your settings are kept on the server and published once your store is activated.';
}
