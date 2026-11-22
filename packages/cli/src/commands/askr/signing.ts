/**
 * The CLI's signing core (5.1, 7): settings as merged values, turned into a
 * `StoreConfigInput` and signed with the existing `buildConfigEvent` and
 * `buildCatalogAuth`. A test signs an equal form with the admin's
 * `signStoreEvents` and compares the two.
 */
import type { ProductSource, StoreConfigInput, StorePrivateConfig } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import type { Askr } from './session';

/** A store's settings as the CLI merges them: the previous config, then the flags given. */
export interface SettingsValues {
  name: string;
  origins: string[];
  linkOrigins: string[];
  language: string;
  currency: string;
  source: ProductSource;
  catalogKey: string;
  policyKey: string;
  displayName?: string;
  greeting?: string;
  launcherText?: string;
  contact?: string;
  private: StorePrivateConfig;
}

export function configInputOf(
  values: SettingsValues,
  assistant: string,
  createdAt: number,
): StoreConfigInput {
  return {
    assistant,
    origins: values.origins,
    linkOrigins: values.linkOrigins,
    name: values.name,
    language: values.language,
    currency: values.currency,
    source: values.source,
    catalogKey: values.catalogKey,
    ...(values.policyKey === values.catalogKey ? {} : { policyKey: values.policyKey }),
    ...(values.displayName === undefined ? {} : { displayName: values.displayName }),
    ...(values.greeting === undefined ? {} : { greeting: values.greeting }),
    ...(values.launcherText === undefined ? {} : { launcherText: values.launcherText }),
    ...(values.contact === undefined ? {} : { contact: values.contact }),
    private: values.private,
    createdAt,
  };
}

export interface SignInput {
  askr: Askr;
  secretKey: Uint8Array;
  /** The config to sign, or none when it is unchanged. */
  config?: StoreConfigInput;
  /** The hosted authorization of server K to sign, or none when it is in force. */
  authorize?: { key: string; createdAt: number };
}

/** The O-signed events to store: the 30496 (private part sealed to A) and the 30497. */
export function signSettings(input: SignInput): NostrEvent[] {
  const events: NostrEvent[] = [];
  if (input.config !== undefined) {
    events.push(
      finalizeEvent(input.askr.buildConfigEvent(input.config, input.secretKey), input.secretKey),
    );
  }
  if (input.authorize !== undefined) {
    events.push(
      finalizeEvent(
        input.askr.buildCatalogAuth({
          key: input.authorize.key,
          mode: 'hosted',
          createdAt: input.authorize.createdAt,
        }),
        input.secretKey,
      ),
    );
  }
  return events;
}
