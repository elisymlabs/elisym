import {
  CONFIG_D_TAG,
  type CatalogItem,
  type CatalogItemInput,
  type CatalogKeyRole,
  KIND_CATALOG_AUTH,
  KIND_CONFIG,
  KIND_POLICY,
  type Policy,
  type StoreConfig,
  parseCatalogItem,
  parseConfig,
  parsePolicy,
  readCatalogAuthority,
} from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import type { RelayReader } from './relay';

const KIND_PRODUCT = 30402;
const KIND_STORE_AUTH = 30490;
const KIND_DELETION = 5;

function dOf(event: NostrEvent): string | undefined {
  return event.tags.find((tag) => tag[0] === 'd')?.[1];
}

/** Newer first; at the same second the lower id wins (NIP-01). */
function isNewer(candidate: NostrEvent, current: NostrEvent): boolean {
  return (
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
  );
}

/** Signed events of `author` of `kind`, newest per `d`. */
export function newestByD(
  events: readonly NostrEvent[],
  kind: number,
  author: string,
): NostrEvent[] {
  const newest = new Map<string, NostrEvent>();
  for (const event of events) {
    const d = dOf(event);
    if (event.kind !== kind || event.pubkey !== author || d === undefined || !verifyEvent(event)) {
      continue;
    }
    const current = newest.get(d);
    if (current === undefined || isNewer(event, current)) {
      newest.set(d, event);
    }
  }
  return [...newest.values()];
}

/** Whether a deletion by the author names the event's address at or after it. */
function deleted(event: NostrEvent, deletions: readonly NostrEvent[]): boolean {
  const address = `${event.kind}:${event.pubkey}:${dOf(event) ?? ''}`;
  return deletions.some(
    (deletion) =>
      deletion.kind === KIND_DELETION &&
      deletion.pubkey === event.pubkey &&
      deletion.created_at >= event.created_at &&
      deletion.tags.some((tag) => tag[0] === 'a' && tag[1] === address) &&
      verifyEvent(deletion),
  );
}

/** The owner's newest config (30496), or undefined when there is none or it does not parse. */
export async function readConfig(
  reader: RelayReader,
  owner: string,
): Promise<StoreConfig | undefined> {
  const events = await reader.query({
    kinds: [KIND_CONFIG],
    authors: [owner],
    '#d': [CONFIG_D_TAG],
  });
  const [newest] = newestByD(events, KIND_CONFIG, owner);
  return newest === undefined ? undefined : parseConfig(newest);
}

/** The keys the owner authorizes now, with their roles (1.2). */
export async function readAuthority(
  reader: RelayReader,
  owner: string,
): Promise<Map<string, Set<CatalogKeyRole>>> {
  const events = await reader.query({
    kinds: [KIND_CATALOG_AUTH, KIND_STORE_AUTH, KIND_DELETION],
    authors: [owner],
  });
  return readCatalogAuthority(
    events.filter((event) => verifyEvent(event)),
    owner,
  );
}

/** The listings a catalog key shows now (hidden ones are left out). */
export async function readListings(reader: RelayReader, key: string): Promise<CatalogItem[]> {
  const events = await reader.query({ kinds: [KIND_PRODUCT], authors: [key] });
  return newestByD(events, KIND_PRODUCT, key).flatMap((event) => {
    const item = parseCatalogItem(event, { role: 'catalog' });
    return item === undefined ? [] : [item];
  });
}

/** The policies a policy key shows now, by slug. */
export async function readPolicies(reader: RelayReader, key: string): Promise<Policy[]> {
  const events = await reader.query({ kinds: [KIND_POLICY, KIND_DELETION], authors: [key] });
  const deletions = events.filter((event) => event.kind === KIND_DELETION);
  return newestByD(events, KIND_POLICY, key)
    .filter((event) => !deleted(event, deletions))
    .flatMap((event) => {
      const policy = parsePolicy(event);
      return policy === undefined ? [] : [policy];
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

/** A listing as the catalog API takes it back, so a re-sent catalog keeps it as it is. */
export function inputOfListing(item: CatalogItem): CatalogItemInput {
  const input: CatalogItemInput = {
    d: item.d,
    title: item.title,
    description: item.description,
    price: {
      amount: item.price.amount,
      currency: item.price.currency,
      ...(item.price.frequency === undefined ? {} : { frequency: item.price.frequency }),
    },
    images: item.images,
    topics: item.topics,
    attrs: item.attrs,
    options: item.options,
    variants: item.variants,
    visibility: item.visibility,
  };
  if (item.summary !== undefined) {
    input.summary = item.summary;
  }
  const [url] = item.links;
  if (url !== undefined) {
    input.url = url;
  }
  if (item.sku !== undefined) {
    input.sku = item.sku;
  }
  if (item.sourceId !== undefined) {
    input.sourceId = item.sourceId;
  }
  if (item.priceFrom) {
    input.priceFrom = true;
  }
  return input;
}
