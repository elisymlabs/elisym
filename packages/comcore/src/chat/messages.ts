import { z } from 'zod';
import { LIMITS } from '../constants';

/** 16 random bytes, hex: one per visitor question, kept on every resend. */
export const ASK_ID_RE = /^[0-9a-f]{32}$/;
const ADDRESS_RE = /^30402:[0-9a-f]{64}:[A-Za-z0-9._:-]{1,128}$/;
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const askId = z.string().regex(ASK_ID_RE);
const address = z.string().regex(ADDRESS_RE);
const title = z.string().min(1).max(LIMITS.TITLE_CHARS);

/** A signed event as JSON (the ticket); verified separately, never trusted for its shape alone. */
const signedEvent = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number().int(),
  kind: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
});

const pageUrl = z
  .string()
  .max(LIMITS.PAGE_URL_BYTES)
  .refine((value) => new TextEncoder().encode(value).length <= LIMITS.PAGE_URL_BYTES)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'an http(s) URL');

export const AskSchema = z.object({
  type: z.literal('ask'),
  ask_id: askId,
  text: z.string().min(1).max(LIMITS.ASK_TEXT_CHARS),
  ticket: signedEvent,
  page: z.object({ url: pageUrl }).optional(),
  locale: z.string().regex(LOCALE_RE).max(LIMITS.LOCALE_CHARS).optional(),
});

export const ProductsComponentSchema = z.object({
  type: z.literal('products'),
  title: title.optional(),
  picks: z
    .array(z.object({ address, reason: z.string().min(1).max(LIMITS.REASON_CHARS).optional() }))
    .min(1)
    .max(LIMITS.MAX_PRODUCT_PICKS),
});

export const ComparisonComponentSchema = z
  .object({
    type: z.literal('comparison'),
    title: title.optional(),
    addresses: z.array(address).min(LIMITS.MIN_COMPARISON).max(LIMITS.MAX_COMPARISON),
    rows: z
      .array(
        z.object({
          dimension: z.string().min(1).max(LIMITS.TITLE_CHARS),
          cells: z.array(z.string().max(LIMITS.REASON_CHARS)).max(LIMITS.MAX_COMPARISON),
        }),
      )
      .max(LIMITS.MAX_COMPARISON_ROWS),
    recommended: address.optional(),
  })
  .refine(
    (comparison) =>
      comparison.rows.every((row) => row.cells.length === comparison.addresses.length),
    'every comparison row has one cell per product',
  )
  .refine(
    (comparison) =>
      comparison.recommended === undefined || comparison.addresses.includes(comparison.recommended),
    'the recommended product is one of the compared ones',
  );

export const PlanComponentSchema = z.object({
  type: z.literal('plan'),
  title,
  steps: z
    .array(
      z.object({
        label: z.string().min(1).max(LIMITS.PLAN_STEP_LABEL_CHARS),
        detail: z.string().max(LIMITS.PLAN_DETAIL_CHARS).optional(),
        addresses: z.array(address).max(LIMITS.MAX_PLAN_STEP_ADDRESSES),
      }),
    )
    .min(1)
    .max(LIMITS.MAX_PLAN_STEPS),
});

export const GuideComponentSchema = z.object({
  type: z.literal('guide'),
  title,
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(LIMITS.TITLE_CHARS),
        body: z.string().min(1).max(LIMITS.GUIDE_BODY_CHARS),
      }),
    )
    .min(1)
    .max(LIMITS.MAX_GUIDE_SECTIONS),
});

// A union, not discriminatedUnion: the comparison schema carries a refinement.
export const ComponentSchema = z.union([
  ProductsComponentSchema,
  ComparisonComponentSchema,
  PlanComponentSchema,
  GuideComponentSchema,
]);

export const AnswerSchema = z.object({
  type: z.literal('answer'),
  ask_id: askId,
  session_end: z.number().int().positive(),
  text: z.string().max(LIMITS.ANSWER_TEXT_CHARS),
  components: z.array(ComponentSchema).max(LIMITS.MAX_COMPONENTS),
  chips: z.array(z.string().min(1).max(LIMITS.CHIP_CHARS)).max(LIMITS.MAX_CHIPS),
});

export const StatusSchema = z.object({
  type: z.literal('status'),
  ask_id: askId,
  text: z.string().min(1).max(LIMITS.STATUS_TEXT_CHARS),
});

export const UNAVAILABLE_REASONS = ['quota', 'budget', 'expired', 'error'] as const;

export const UnavailableSchema = z.object({
  type: z.literal('unavailable'),
  ask_id: askId,
  reason: z.enum(UNAVAILABLE_REASONS),
});

export const ChatMessageSchema = z.discriminatedUnion('type', [
  AskSchema,
  AnswerSchema,
  StatusSchema,
  UnavailableSchema,
]);

export type Ask = z.infer<typeof AskSchema>;
export type Answer = z.infer<typeof AnswerSchema>;
export type Status = z.infer<typeof StatusSchema>;
export type Unavailable = z.infer<typeof UnavailableSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type Component = z.infer<typeof ComponentSchema>;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** Messages the assistant sends; an ask only ever comes from a visitor. */
export function isAssistantMessage(message: ChatMessage): message is Answer | Status | Unavailable {
  return message.type !== 'ask';
}

/** A fresh `ask_id`: 16 random bytes, hex. */
export function newAskId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
