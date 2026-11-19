import { nowSecs, tagValue } from '@elisym/commerce';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import * as z from 'zod';
import { KIND_POLICY, LIMITS, SHOPIFY_POLICY_SLUGS } from '../constants';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface Policy {
  author: string;
  slug: string;
  title: string;
  /** Markdown, store-authored: fenced before any model reads it. */
  body: string;
  createdAt: number;
}

export const PolicyInputSchema = z.object({
  slug: z.string().regex(SLUG_RE),
  title: z.string().min(1).max(LIMITS.TITLE_CHARS),
  body: z.string().min(1).max(LIMITS.POLICY_CONTENT_CHARS),
  createdAt: z.number().int().positive().optional(),
});

export type PolicyInput = z.input<typeof PolicyInputSchema>;

/**
 * The policies an assistant reads (2.2): at most MAX_POLICIES. The slugs a
 * Shopify connector imports come first, so a store past the cap never loses
 * its returns or shipping policy to its own extra ones; then by slug, in
 * character order.
 */
export function policiesInUse<T extends { slug: string }>(policies: readonly T[]): T[] {
  const rank = (slug: string) => {
    const imported = SHOPIFY_POLICY_SLUGS.findIndex((entry) => entry.slug === slug);
    return imported === -1 ? SHOPIFY_POLICY_SLUGS.length : imported;
  };
  return [...policies]
    .sort((left, right) => {
      const byRank = rank(left.slug) - rank(right.slug);
      if (byRank !== 0) {
        return byRank;
      }
      if (left.slug === right.slug) {
        return 0;
      }
      return left.slug < right.slug ? -1 : 1;
    })
    .slice(0, LIMITS.MAX_POLICIES);
}

/** Build a policy / FAQ entry (2.2). The caller signs it with the store's policy key. */
export function buildPolicyEvent(input: PolicyInput): EventTemplate {
  const policy = PolicyInputSchema.parse(input);
  return {
    kind: KIND_POLICY,
    created_at: policy.createdAt ?? nowSecs(),
    tags: [
      ['d', policy.slug],
      ['title', policy.title],
    ],
    content: policy.body,
  };
}

/** Read a policy, or `undefined` when it is malformed. The caller checked signature and author. */
export function parsePolicy(
  event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags' | 'content' | 'created_at'>,
): Policy | undefined {
  if (event.kind !== KIND_POLICY || event.content.length > LIMITS.POLICY_CONTENT_CHARS) {
    return undefined;
  }
  const slug = tagValue(event.tags, 'd');
  const title = tagValue(event.tags, 'title');
  if (slug === undefined || !SLUG_RE.test(slug) || !title || title.length > LIMITS.TITLE_CHARS) {
    return undefined;
  }
  if (event.content.length === 0) {
    return undefined;
  }
  return {
    author: event.pubkey,
    slug,
    title,
    body: event.content,
    createdAt: event.created_at,
  };
}
