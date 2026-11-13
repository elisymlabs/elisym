/**
 * The eval case file and synthetic store file (spec 8): schemas, loaders and
 * the lint the tests run over them.
 */
import { CatalogItemInputSchema, PolicyInputSchema, StoreConfigInputSchema } from '@elisym/askr';
import { z } from 'zod';

export const CATEGORIES = [
  'search',
  'compare',
  'cheapest',
  'budget',
  'plan',
  'context',
  'policy',
  'multilingual',
  'availability',
  'unknown-facts',
  'no-invention',
  'injection',
  'honesty',
  'prices',
  'history',
] as const;
export type Category = (typeof CATEGORIES)[number];

const PRODUCT_IDS = z.array(z.string().min(1)).min(1);
const PATTERNS = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const ExpectSchema = z
  .object({
    /** At least one of these ids is presented. */
    presentsAny: PRODUCT_IDS.optional(),
    /** Every one of these ids is presented. */
    presentsAll: PRODUCT_IDS.optional(),
    /** The first presented id (the recommended one, as the tools ask) is this one. */
    presentsFirst: z.string().min(1).optional(),
    /** None of these ids is presented. */
    presentsNone: PRODUCT_IDS.optional(),
    /** At most this many distinct ids are presented. */
    maxPresented: z.number().int().min(0).optional(),
    /** At least one component (cards, comparison, plan or guide). */
    hasComponents: z.literal(true).optional(),
    /** No component at all (a pure text answer). */
    noComponents: z.literal(true).optional(),
    /** The answer text matches each pattern (case-insensitive regex). */
    textMatches: PATTERNS.optional(),
    /** The answer text matches none of the patterns. */
    textNotMatches: PATTERNS.optional(),
  })
  .strict();
export type Expectation = z.infer<typeof ExpectSchema>;

const CaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    category: z.enum(CATEGORIES),
    message: z.string().min(1),
    page: z.string().url().optional(),
    locale: z.string().min(2).optional(),
    /** Earlier turns: visitor, assistant, visitor, assistant... (an even count). */
    history: z.array(z.string().min(1)).optional(),
    /** Policy slugs whose passages earlier turns already returned. */
    earlierPolicies: z.array(z.string().min(1)).optional(),
    /** Why the case exists, for the reader of a failure. */
    note: z.string().optional(),
    expect: ExpectSchema,
  })
  .strict();
export type EvalCase = z.infer<typeof CaseSchema>;

const CasesFileSchema = z.array(CaseSchema).min(1);

const EvalStoreSchema = z
  .object({
    config: StoreConfigInputSchema.pick({
      origins: true,
      linkOrigins: true,
      name: true,
      language: true,
      currency: true,
      source: true,
    }).strict(),
    private: z
      .object({ voice: z.string(), instructions: z.string(), notes: z.string() })
      .strict()
      .optional(),
    items: z.array(CatalogItemInputSchema).min(1),
    policies: z.array(PolicyInputSchema.omit({ createdAt: true }).strict()),
  })
  .strict();
export type EvalStore = z.infer<typeof EvalStoreSchema>;

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function parseCases(json: unknown): EvalCase[] {
  const parsed = CasesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`The case file is invalid: ${issues(parsed.error)}`);
  }
  return parsed.data;
}

export function parseStore(json: unknown): EvalStore {
  const parsed = EvalStoreSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`The store file is invalid: ${issues(parsed.error)}`);
  }
  return parsed.data;
}

export function patternsOf(patterns: string | string[] | undefined): string[] {
  if (patterns === undefined) {
    return [];
  }
  return typeof patterns === 'string' ? [patterns] : patterns;
}

/** Case-insensitive, as every grader regex is. Throws on a pattern that does not compile. */
export function graderRegex(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

/**
 * How many checks a case makes (the price check is always on and not counted).
 * Text checks read the answer text and every model-written component string.
 */
export function checkCount(expectation: Expectation): number {
  return (
    (expectation.presentsAny ? 1 : 0) +
    (expectation.presentsAll ? 1 : 0) +
    (expectation.presentsFirst ? 1 : 0) +
    (expectation.presentsNone ? 1 : 0) +
    (expectation.maxPresented !== undefined ? 1 : 0) +
    (expectation.hasComponents ? 1 : 0) +
    (expectation.noComponents ? 1 : 0) +
    patternsOf(expectation.textMatches).length +
    patternsOf(expectation.textNotMatches).length
  );
}

/**
 * Problems in a case file against its store: duplicate ids, unknown product
 * ids or policy slugs, regexes that do not compile, cases without a check,
 * odd-length histories, contradictory checks. Empty when the file is sound.
 */
export function lintCases(cases: readonly EvalCase[], store: EvalStore): string[] {
  const problems: string[] = [];
  const productIds = new Set(store.items.map((item) => item.d));
  const policySlugs = new Set(store.policies.map((policy) => policy.slug));
  const seen = new Set<string>();
  for (const testCase of cases) {
    const where = `case ${testCase.id}`;
    if (seen.has(testCase.id)) {
      problems.push(`${where}: duplicate id`);
    }
    seen.add(testCase.id);
    const { expect: expectation } = testCase;
    if (checkCount(expectation) === 0) {
      problems.push(`${where}: no check`);
    }
    const referenced = [
      ...(expectation.presentsAny ?? []),
      ...(expectation.presentsAll ?? []),
      ...(expectation.presentsFirst ? [expectation.presentsFirst] : []),
      ...(expectation.presentsNone ?? []),
    ];
    for (const productId of referenced) {
      if (!productIds.has(productId)) {
        problems.push(`${where}: unknown product ${productId}`);
      }
    }
    const forbidden = new Set(expectation.presentsNone ?? []);
    for (const productId of [
      ...(expectation.presentsAll ?? []),
      ...(expectation.presentsFirst ? [expectation.presentsFirst] : []),
    ]) {
      if (forbidden.has(productId)) {
        problems.push(`${where}: ${productId} is both required and forbidden`);
      }
    }
    const anyOf = expectation.presentsAny ?? [];
    if (anyOf.length > 0 && anyOf.every((productId) => forbidden.has(productId))) {
      problems.push(`${where}: every presentsAny id is forbidden`);
    }
    if (
      expectation.noComponents &&
      (expectation.presentsAny ||
        expectation.presentsAll ||
        expectation.presentsFirst ||
        expectation.hasComponents)
    ) {
      problems.push(`${where}: noComponents contradicts a presents check`);
    }
    for (const pattern of [
      ...patternsOf(expectation.textMatches),
      ...patternsOf(expectation.textNotMatches),
    ]) {
      try {
        graderRegex(pattern);
      } catch {
        problems.push(`${where}: regex does not compile: ${pattern}`);
      }
    }
    if ((testCase.history ?? []).length % 2 !== 0) {
      problems.push(`${where}: history must alternate visitor and assistant and end on assistant`);
    }
    for (const slug of testCase.earlierPolicies ?? []) {
      if (!policySlugs.has(slug)) {
        problems.push(`${where}: unknown policy ${slug}`);
      }
    }
  }
  return [...new Set(problems)];
}
