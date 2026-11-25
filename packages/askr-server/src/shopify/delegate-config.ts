import {
  CONFIG_D_TAG,
  KIND_CONFIG,
  KIND_CONFIG_DELEGATION,
  LIMITS,
  type StoreConfigInput,
  type StorePrivateConfig,
  buildConfigEvent,
  readConfigDelegates,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';

/** A delegate config may be dated at most this far ahead of the server's clock (plan 3.4). */
export const DELEGATE_CONFIG_MAX_AHEAD_SECS = 60;
/** The config readers' language form (`@elisym/askr`'s `LANGUAGE_RE`). */
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;
const FALLBACK_LANGUAGE = 'en';
const FALLBACK_NAME = 'Shop';

function tagOf(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/**
 * A shop name as a config `name`: whole code points only, at most `LIMITS.TITLE_CHARS` UTF-16
 * units, so an astral character at the cut is dropped whole, never split (plan 3.3).
 */
export function configName(shopName: string): string {
  let name = '';
  for (const char of shopName.trim()) {
    if (name.length + char.length > LIMITS.TITLE_CHARS) {
      break;
    }
    name += char;
  }
  name = name.trim();
  return name === '' ? FALLBACK_NAME : name;
}

/** The shop's primary locale as a config language (plan 3.3): as is when valid, else `en`. */
export function configLanguage(locale: string | undefined): string {
  const candidate = locale?.trim() ?? '';
  if (LANGUAGE_RE.test(candidate) && candidate.length <= LIMITS.LOCALE_CHARS) {
    return candidate;
  }
  const primary = candidate.split(/[-_]/u)[0] ?? '';
  return /^[A-Za-z]{2,3}$/u.test(primary) ? primary.toLowerCase() : FALLBACK_LANGUAGE;
}

/**
 * The newest `created_at` among a store's stored configs of any signer, or undefined: a new
 * config is dated after it, since intake keeps configs strictly increasing across signers.
 */
export function newestConfigAt(events: readonly NostrEvent[]): number | undefined {
  let newest: number | undefined;
  for (const event of events) {
    if (event.kind === KIND_CONFIG && tagOf(event, 'd') === CONFIG_D_TAG) {
      newest = newest === undefined ? event.created_at : Math.max(newest, event.created_at);
    }
  }
  return newest;
}

/**
 * Whether D is in charge of the store's settings (plan 3.4): `delegateActive`, D active by the
 * owner's grants, and D's newest grant newer than the owner's newest config. Otherwise the
 * merchant manages the store with O. `events` are genuine (stored ones were checked on intake).
 */
export function delegateInCharge(
  events: readonly NostrEvent[],
  owner: string,
  delegate: string,
  delegateActive: boolean,
  now: number,
): boolean {
  if (!delegateActive || !readConfigDelegates(events, owner, now).includes(delegate)) {
    return false;
  }
  let grantAt: number | undefined;
  let ownerConfigAt: number | undefined;
  for (const event of events) {
    if (event.pubkey !== owner) {
      continue;
    }
    if (event.kind === KIND_CONFIG_DELEGATION && tagOf(event, 'd') === delegate) {
      grantAt = Math.max(grantAt ?? event.created_at, event.created_at);
    } else if (event.kind === KIND_CONFIG && tagOf(event, 'd') === CONFIG_D_TAG) {
      ownerConfigAt = Math.max(ownerConfigAt ?? event.created_at, event.created_at);
    }
  }
  return grantAt !== undefined && (ownerConfigAt === undefined || grantAt > ownerConfigAt);
}

/** The time a new delegate config is dated at, or undefined when that is too far ahead (3.4). */
export function delegateConfigTime(
  storedEvents: readonly NostrEvent[],
  now: number,
): number | undefined {
  const newest = newestConfigAt(storedEvents);
  const at = Math.max(now, newest === undefined ? now : newest + 1);
  return at > now + DELEGATE_CONFIG_MAX_AHEAD_SECS ? undefined : at;
}

/** What the server fills in on every delegate config: never from the request (plan 3.4). */
export interface DelegateConfigKeys {
  /** `next_assistant ?? assistant`. */
  assistant: string;
  catalogKey: string;
}

/** The settings a delegate config carries beyond the keys and the shop source. */
export type DelegateSettings = Omit<
  StoreConfigInput,
  'assistant' | 'catalogKey' | 'policyKey' | 'source' | 'createdAt' | 'private'
> & { private?: Partial<StorePrivateConfig> };

/** A config signed by D, naming the store's keys and the shop as its connector source. */
export function signDelegateConfig(input: {
  settings: DelegateSettings;
  keys: DelegateConfigKeys;
  shopUrl: string;
  createdAt: number;
  delegateSecret: Uint8Array;
}): NostrEvent {
  const config: StoreConfigInput = {
    ...input.settings,
    assistant: input.keys.assistant,
    catalogKey: input.keys.catalogKey,
    source: { kind: 'connector', platform: 'shopify', shopUrl: input.shopUrl },
    createdAt: input.createdAt,
  };
  return finalizeEvent(buildConfigEvent(config, input.delegateSecret), input.delegateSecret);
}
