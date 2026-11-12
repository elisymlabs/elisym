import {
  ASKR_RELAYS,
  KIND_POLICY,
  type PolicyInput,
  type SyncRelayClient,
  parsePolicy,
  removePolicy,
  setPolicy,
} from '@elisym/askr';
import { KIND_DELETION, isEventShaped, isGenuineEvent, tagValues } from '@elisym/commerce';
import { getPublicKey } from 'nostr-tools/pure';

export interface PolicyDiff {
  set: string[];
  removed: string[];
  unchanged: string[];
  /** Slugs whose body or title was cut to the 2.2 caps. */
  truncated: string[];
}

export interface SyncImportedPoliciesOptions {
  /** The store's policy key (for a connector source, the server K). */
  signer: Uint8Array;
  store: string;
  client: SyncRelayClient;
  policies: ReadonlyArray<{ input: PolicyInput; truncated: boolean }>;
  /** The slugs the import owns: one of them missing from `policies` is removed. */
  managedSlugs: readonly string[];
  dryRun?: boolean;
  now?: number;
}

/** The live title and body of each of `key`'s policies: newest version, not deleted since. */
async function livePolicies(
  client: SyncRelayClient,
  key: string,
): Promise<Map<string, { title: string; body: string }>> {
  const events = (
    await client.query(ASKR_RELAYS, {
      kinds: [KIND_POLICY, KIND_DELETION],
      authors: [key],
    })
  ).filter((event) => isEventShaped(event) && event.pubkey === key && isGenuineEvent(event));
  const deletedAt = new Map<string, number>();
  const newest = new Map<string, { createdAt: number; title: string; body: string }>();
  const prefix = `${KIND_POLICY}:${key}:`;
  for (const event of events) {
    if (event.kind === KIND_DELETION) {
      for (const address of tagValues(event.tags, 'a')) {
        if (address.startsWith(prefix)) {
          const slug = address.slice(prefix.length);
          deletedAt.set(slug, Math.max(deletedAt.get(slug) ?? -1, event.created_at));
        }
      }
      continue;
    }
    const policy = parsePolicy(event);
    const current = policy ? newest.get(policy.slug) : undefined;
    if (policy && (!current || current.createdAt < policy.createdAt)) {
      newest.set(policy.slug, {
        createdAt: policy.createdAt,
        title: policy.title,
        body: policy.body,
      });
    }
  }
  const live = new Map<string, { title: string; body: string }>();
  for (const [slug, policy] of newest) {
    if ((deletedAt.get(slug) ?? -1) < policy.createdAt) {
      live.set(slug, { title: policy.title, body: policy.body });
    }
  }
  return live;
}

/**
 * Bring the imported policies on the relay in line with the shop: publish new
 * or changed ones, remove managed slugs the shop no longer has, and leave
 * unchanged ones alone (a poll every few minutes must not republish them).
 */
export async function syncImportedPolicies(
  options: SyncImportedPoliciesOptions,
): Promise<PolicyDiff> {
  const key = getPublicKey(options.signer);
  const live = await livePolicies(options.client, key);
  const diff: PolicyDiff = {
    set: [],
    removed: [],
    unchanged: [],
    truncated: [],
  };
  const write = {
    signer: options.signer,
    store: options.store,
    client: options.client,
  };
  const nowOption = options.now === undefined ? {} : { now: options.now };
  const imported = new Set<string>();
  for (const { input, truncated } of options.policies) {
    imported.add(input.slug);
    if (truncated) {
      diff.truncated.push(input.slug);
    }
    const current = live.get(input.slug);
    if (current && current.title === input.title && current.body === input.body) {
      diff.unchanged.push(input.slug);
      continue;
    }
    diff.set.push(input.slug);
    if (!options.dryRun) {
      await setPolicy({ ...write, ...nowOption, policy: input });
    }
  }
  for (const slug of options.managedSlugs) {
    if (imported.has(slug) || !live.has(slug)) {
      continue;
    }
    diff.removed.push(slug);
    if (!options.dryRun) {
      await removePolicy({ ...write, ...nowOption, slug });
    }
  }
  return diff;
}
