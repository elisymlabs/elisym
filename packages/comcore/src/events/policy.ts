import { nowSecs, tagValue } from '@elisym/commerce';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { z } from 'zod';
import { KIND_POLICY, LIMITS } from '../constants';

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
