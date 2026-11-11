import { type CatalogItem, type Component, LIMITS, catalogAddress } from '@elisym/comcore';
import Decimal from 'decimal.js-light';
import { z } from 'zod';
import {
  AVAILABILITY,
  type StoreCatalog,
  availabilityOf,
  priceOf,
  tokenize,
  topAttrs,
} from './catalog/store-catalog';
import { fence, sanitizeText } from './fence';
import type { ToolSpec, ToolUseBlock } from './llm/types';
import { SKILL_NAMES, skillText } from './skills';
import { sanitizeAnswerText } from './text-sanitize';

export const MAX_SEARCH_RESULTS = 12;
const DEFAULT_SEARCH_RESULTS = 8;
const TOP_ATTRS = 5;
const DESCRIPTION_FENCE_CHARS = 6_000;
const POLICY_FENCE_CHARS = 3_000;
const MAX_POLICY_RESULTS = 3;
const MAX_STATUS_LINES_PER_TURN = 2;
const PRICE_DIMENSION = 'Price';
const READ_TOOLS: readonly string[] = ['search_products', 'get_product_details', 'search_policies'];
const FREQUENCY_FILTERS = ['once', 'hour', 'day', 'week', 'month', 'year'] as const;

const statusProperty = {
  status: {
    type: 'string',
    maxLength: LIMITS.STATUS_TEXT_CHARS,
    description: 'A short progress line for the visitor, in their language (optional).',
  },
};

/** The tool list: fixed order and bytes for every store on a tier (5.2), so the prefix caches. */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'load_skill',
    description:
      "Load the rules of the flow the request matches (see the skill index). Call it in the same round as the flow's first read.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: [...SKILL_NAMES] } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_products',
    description:
      'Search the catalog. Write the query in the catalog language. Put constraints the visitor stated in filters. Returns ids, titles, prices, availability and top attributes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in the catalog language.' },
        filters: {
          type: 'object',
          properties: {
            min_price: { type: ['number', 'string'], description: 'In the store currency.' },
            max_price: { type: ['number', 'string'], description: 'In the store currency.' },
            topics: { type: 'array', items: { type: 'string' } },
            attrs: { type: 'object', additionalProperties: { type: 'string' } },
            availability: { type: 'string', enum: [...AVAILABILITY] },
            frequency: {
              type: 'string',
              enum: [...FREQUENCY_FILTERS],
              description:
                'once for one-off prices (the default with price limits), or a subscription period.',
            },
            sort: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc'] },
          },
          additionalProperties: false,
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS },
        ...statusProperty,
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_product_details',
    description:
      'Full details for one product id: description, attributes, options and variants with prices and availability.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, ...statusProperty },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_policies',
    description: 'Search the store policies and FAQ (shipping, returns, sizing...).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, ...statusProperty },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'present_products',
    description:
      'Show product cards, recommended first. Each reason is one clause naming the visitor constraint it meets. The card shows price, image and link itself: do not restate prices.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: LIMITS.TITLE_CHARS },
        picks: {
          type: 'array',
          minItems: 1,
          maxItems: LIMITS.MAX_PRODUCT_PICKS,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              reason: { type: 'string', maxLength: LIMITS.REASON_CHARS },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
      },
      required: ['picks'],
      additionalProperties: false,
    },
  },
  {
    name: 'present_comparison',
    description:
      'Compare 2-4 products on the dimensions the visitor raised. Give one cell per product in each row, in the order of ids. The price row is added by the store: never add one.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: LIMITS.TITLE_CHARS },
        ids: {
          type: 'array',
          minItems: LIMITS.MIN_COMPARISON,
          maxItems: LIMITS.MAX_COMPARISON,
          items: { type: 'string' },
        },
        rows: {
          type: 'array',
          maxItems: LIMITS.MAX_COMPARISON_ROWS - 1,
          items: {
            type: 'object',
            properties: {
              dimension: { type: 'string', maxLength: LIMITS.TITLE_CHARS },
              cells: { type: 'array', items: { type: 'string', maxLength: LIMITS.REASON_CHARS } },
            },
            required: ['dimension', 'cells'],
            additionalProperties: false,
          },
        },
        recommended: { type: 'string' },
      },
      required: ['ids', 'rows'],
      additionalProperties: false,
    },
  },
  {
    name: 'present_plan',
    description: 'Show a plan toward a goal (an outfit, a set, a bundle under a budget).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: LIMITS.TITLE_CHARS },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: LIMITS.MAX_PLAN_STEPS,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', maxLength: LIMITS.PLAN_STEP_LABEL_CHARS },
              detail: { type: 'string', maxLength: LIMITS.PLAN_DETAIL_CHARS },
              ids: {
                type: 'array',
                maxItems: LIMITS.MAX_PLAN_STEP_ADDRESSES,
                items: { type: 'string' },
              },
            },
            required: ['label', 'ids'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'present_guide',
    description: 'Show buying criteria for a category, one criterion per section.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: LIMITS.TITLE_CHARS },
        sections: {
          type: 'array',
          minItems: 1,
          maxItems: LIMITS.MAX_GUIDE_SECTIONS,
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', maxLength: LIMITS.TITLE_CHARS },
              body: { type: 'string', maxLength: LIMITS.GUIDE_BODY_CHARS },
            },
            required: ['heading', 'body'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'sections'],
      additionalProperties: false,
    },
  },
  {
    name: 'present_suggestions',
    description: 'Offer up to 4 short follow-up replies the visitor can tap.',
    inputSchema: {
      type: 'object',
      properties: {
        chips: {
          type: 'array',
          minItems: 1,
          maxItems: LIMITS.MAX_CHIPS,
          items: { type: 'string', maxLength: LIMITS.CHIP_CHARS },
        },
      },
      required: ['chips'],
      additionalProperties: false,
    },
  },
];

/** What one turn accumulates while the model calls tools. */
export interface TurnState {
  /** Ids the model may present: the prompt snapshot plus ids tools returned (5.5). */
  allowedIds: Set<string>;
  components: Component[];
  chips: string[];
  statuses: string[];
  /** Policy passages returned this session: their amounts are quotable (5.5). */
  policyPassages: string[];
}

/**
 * A fresh state for one model loop. `allowedIds` and `statuses` are passed in
 * by the turn (and the session), so a corrective re-run keeps what the first
 * loop earned and the two-status cap holds for the whole turn.
 */
export function newTurnState(
  allowedIds: Set<string>,
  policyPassages: string[],
  statuses: string[] = [],
): TurnState {
  return { allowedIds, components: [], chips: [], statuses, policyPassages };
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const AMOUNT_INPUT_RE = /^\d{1,12}([.,]\d{1,18})?$/;

/** A price filter: a number or a decimal string ("80", "80.5", "80,50"); `invalid` when unreadable. */
function priceFilter(value: unknown): Decimal | undefined | 'invalid' {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return new Decimal(String(value));
  }
  if (typeof value === 'string' && AMOUNT_INPUT_RE.test(value.trim())) {
    return new Decimal(value.trim().replace(',', '.'));
  }
  return 'invalid';
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      record[name] = entry;
    }
  }
  return record;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function summarize(catalog: StoreCatalog, item: CatalogItem) {
  return {
    id: item.d,
    title: sanitizeText(item.title, LIMITS.TITLE_CHARS * 2),
    price: item.price.amount,
    currency: item.price.currency,
    ...(item.priceFrom ? { price_from: true } : {}),
    ...(item.price.frequency ? { frequency: item.price.frequency } : {}),
    availability: availabilityOf(item),
    attrs: topAttrs(item, TOP_ATTRS).map(
      (attr) => `${sanitizeText(attr.name, 32)}: ${sanitizeText(attr.value, 128)}`,
    ),
    ...(catalog.pageUrl(item) ? {} : { no_page_link: true }),
  };
}

function searchProducts(catalog: StoreCatalog, input: Record<string, unknown>, state: TurnState) {
  const query = typeof input.query === 'string' ? input.query : '';
  const filters =
    typeof input.filters === 'object' && input.filters !== null ? { ...input.filters } : {};
  const filterRecord: Record<string, unknown> = filters;
  const minPrice = priceFilter(filterRecord.min_price);
  const maxPrice = priceFilter(filterRecord.max_price);
  if (minPrice === 'invalid' || maxPrice === 'invalid') {
    return {
      error: 'min_price and max_price must be numbers in the store currency, like 80 or 79.90.',
    };
  }
  const frequency = FREQUENCY_FILTERS.find((value) => value === filterRecord.frequency);
  const topics = stringArray(filterRecord.topics).map((topic) => topic.toLowerCase());
  const attrs = stringRecord(filterRecord.attrs);
  const availability = AVAILABILITY.find((value) => value === filterRecord.availability);
  const sort = ['price_asc', 'price_desc'].includes(String(filterRecord.sort))
    ? String(filterRecord.sort)
    : 'relevance';
  const requested =
    typeof input.limit === 'number' ? Math.floor(input.limit) : DEFAULT_SEARCH_RESULTS;
  const limit = Math.min(Math.max(requested, 1), MAX_SEARCH_RESULTS);
  const scores = catalog.scores(query);
  const hasQueryTerms = tokenize(query).length > 0;
  const pricedFilter = minPrice !== undefined || maxPrice !== undefined;
  let matches = [...catalog.items.values()].filter((item) => {
    const price = priceOf(item);
    // Price limits compare like with like (5.2): one-off prices unless a frequency is asked for.
    const itemFrequency = item.price.frequency ?? 'once';
    if ((frequency !== undefined || pricedFilter) && itemFrequency !== (frequency ?? 'once')) {
      return false;
    }
    if (minPrice && price.lessThan(minPrice)) {
      return false;
    }
    if (maxPrice && price.greaterThan(maxPrice)) {
      return false;
    }
    if (
      topics.length > 0 &&
      !topics.some((topic) =>
        item.topics.map((itemTopic) => itemTopic.toLowerCase()).includes(topic),
      )
    ) {
      return false;
    }
    for (const [name, value] of Object.entries(attrs)) {
      const lower = value.toLowerCase();
      const inAttrs = topAttrs(item, 30).some(
        (attr) =>
          attr.name.toLowerCase() === name.toLowerCase() && attr.value.toLowerCase() === lower,
      );
      const inOptions = item.options.some(
        (option) =>
          option.name.toLowerCase() === name.toLowerCase() &&
          option.values.some((optionValue) => optionValue.toLowerCase() === lower),
      );
      if (!inAttrs && !inOptions) {
        return false;
      }
    }
    if (availability && availabilityOf(item) !== availability) {
      return false;
    }
    // A query with terms must match something; a pure filter query lists everything that passes.
    return !hasQueryTerms || (scores.get(item.d) ?? 0) > 0;
  });
  if (sort === 'relevance') {
    matches.sort((left, right) => (scores.get(right.d) ?? 0) - (scores.get(left.d) ?? 0));
  } else {
    const direction = sort === 'price_asc' ? 1 : -1;
    // One-off prices first, then each subscription frequency: never compared across (5.2).
    matches.sort((left, right) => {
      const leftFrequency = left.price.frequency ?? '';
      const rightFrequency = right.price.frequency ?? '';
      if (leftFrequency !== rightFrequency) {
        return leftFrequency < rightFrequency ? -1 : 1;
      }
      return priceOf(left).comparedTo(priceOf(right)) * direction;
    });
  }
  const total = matches.length;
  matches = matches.slice(0, limit);
  for (const item of matches) {
    state.allowedIds.add(item.d);
  }
  return { results: matches.map((item) => summarize(catalog, item)), total };
}

function productDetails(
  catalog: StoreCatalog,
  input: Record<string, unknown>,
  state: TurnState,
): ToolOutcome {
  const id = typeof input.id === 'string' ? input.id : '';
  const item = catalog.items.get(id);
  if (!item) {
    return {
      content: JSON.stringify({ error: 'No product with this id in the catalog.' }),
      isError: true,
    };
  }
  state.allowedIds.add(item.d);
  return {
    content: JSON.stringify({
      ...summarize(catalog, item),
      summary: item.summary ? sanitizeText(item.summary, 1_000) : undefined,
      description: fence('product', item.description, DESCRIPTION_FENCE_CHARS),
      options: item.options.map((option) => ({
        name: sanitizeText(option.name, 32),
        values: option.values.map((value) => sanitizeText(value, 128)),
      })),
      variants: item.variants.map((variant) => ({
        price: variant.price,
        available: variant.available,
        values: variant.values.map((value) => sanitizeText(value, 128)),
      })),
    }),
  };
}

function searchPolicies(catalog: StoreCatalog, input: Record<string, unknown>, state: TurnState) {
  const query = tokenize(typeof input.query === 'string' ? input.query : '');
  const ranked = catalog.policies
    .map((policy) => {
      const terms = new Set(tokenize(`${policy.slug} ${policy.title} ${policy.body}`));
      return { policy, score: query.filter((term) => terms.has(term)).length };
    })
    .filter((entry) => entry.score > 0 || query.length === 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_POLICY_RESULTS);
  for (const entry of ranked) {
    state.policyPassages.push(entry.policy.body);
  }
  return {
    results: ranked.map((entry) => ({
      slug: entry.policy.slug,
      title: sanitizeText(entry.policy.title, LIMITS.TITLE_CHARS),
      passage: fence('policy', entry.policy.body, POLICY_FENCE_CHARS),
    })),
  };
}

/** Resolve model ids against the allowed set and the current catalog; report the rest. */
function resolveIds(catalog: StoreCatalog, state: TurnState, ids: string[]) {
  const kept: CatalogItem[] = [];
  const dropped: string[] = [];
  for (const id of ids) {
    const item = catalog.items.get(id);
    if (item && state.allowedIds.has(id)) {
      kept.push(item);
    } else {
      dropped.push(id);
    }
  }
  return { kept, dropped };
}

const addressOf = (item: CatalogItem) => catalogAddress(item.author, item.d);

/** Every model-written string goes through the answer sanitizer (4.3) before it is kept. */
/**
 * Every model-written string goes through the answer sanitizer (4.3) and is
 * cut to its limit afterwards: NFKC can lengthen text past what zod checked.
 */
const clean = (text: string, max: number): string => sanitizeAnswerText(text).slice(0, max);

/** A price row the model wrote under any common name, or one of bare numbers: the server owns prices. */
// cspell:disable
const PRICE_DIMENSION_RE =
  /price|cost|preis|prix|precio|preço|prezzo|prijs|cena|cen[ay]|цен|стоим|ціна|вартість|価格|价格|價格|가격|fiyat/i;
// cspell:enable
const isBareNumber = (cell: string) => /^[\p{Nd}\s.,'’]+$/u.test(cell.trim());

function presentationResult(dropped: string[], accepted: boolean): ToolOutcome {
  if (!accepted) {
    return {
      content: JSON.stringify({
        error: 'Nothing left to show: every id was unknown or not returned by a tool this session.',
        dropped,
      }),
      isError: true,
    };
  }
  return {
    content: JSON.stringify({
      shown: true,
      ...(dropped.length > 0
        ? {
            dropped,
            note: 'These ids were not shown: unknown or not returned by a tool this session.',
          }
        : {}),
    }),
  };
}

const ProductsInput = z.object({
  title: z.string().max(LIMITS.TITLE_CHARS).optional(),
  picks: z
    .array(z.object({ id: z.string(), reason: z.string().max(LIMITS.REASON_CHARS).optional() }))
    .min(1)
    .max(LIMITS.MAX_PRODUCT_PICKS),
});
const ComparisonInput = z.object({
  title: z.string().max(LIMITS.TITLE_CHARS).optional(),
  ids: z.array(z.string()).min(LIMITS.MIN_COMPARISON).max(LIMITS.MAX_COMPARISON),
  rows: z
    .array(
      z.object({
        dimension: z.string().max(LIMITS.TITLE_CHARS),
        cells: z.array(z.string().max(LIMITS.REASON_CHARS)),
      }),
    )
    .max(LIMITS.MAX_COMPARISON_ROWS - 1),
  recommended: z.string().optional(),
});
const PlanInput = z.object({
  title: z.string().min(1).max(LIMITS.TITLE_CHARS),
  steps: z
    .array(
      z.object({
        label: z.string().min(1).max(LIMITS.PLAN_STEP_LABEL_CHARS),
        detail: z.string().max(LIMITS.PLAN_DETAIL_CHARS).optional(),
        ids: z.array(z.string()).max(LIMITS.MAX_PLAN_STEP_ADDRESSES),
      }),
    )
    .min(1)
    .max(LIMITS.MAX_PLAN_STEPS),
});
const GuideInput = z.object({
  title: z.string().min(1).max(LIMITS.TITLE_CHARS),
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
const SuggestionsInput = z.object({
  chips: z.array(z.string().min(1).max(LIMITS.CHIP_CHARS)).min(1).max(LIMITS.MAX_CHIPS),
});

function invalid(error: z.ZodError): ToolOutcome {
  return {
    content: JSON.stringify({
      error: 'Invalid arguments',
      issues: error.issues.map((issue) => issue.message),
    }),
    isError: true,
  };
}

/** Price cells for a comparison, from the catalog, never from the model (5.5). */
function priceCell(item: CatalogItem): string {
  const amount = new Decimal(item.price.amount).toString();
  const base = `${item.priceFrom ? 'from ' : ''}${amount} ${item.price.currency}`;
  return item.price.frequency ? `${base} / ${item.price.frequency}` : base;
}

export function executeTool(
  catalog: StoreCatalog,
  state: TurnState,
  call: ToolUseBlock,
): ToolOutcome {
  const input = call.input;
  // Status lines only from the read tools (5.2), at most two per turn (4.2).
  if (
    READ_TOOLS.includes(call.name) &&
    typeof input.status === 'string' &&
    state.statuses.length < MAX_STATUS_LINES_PER_TURN
  ) {
    const line = clean(input.status, LIMITS.STATUS_TEXT_CHARS).trim();
    // A status goes out before any check runs, so it carries no number at all:
    // whatever a model writes there cannot state a price.
    if (line.length > 0 && !/\p{N}/u.test(line)) {
      state.statuses.push(line);
    }
  }
  switch (call.name) {
    case 'load_skill': {
      const text = typeof input.name === 'string' ? skillText(input.name) : undefined;
      return text === undefined
        ? { content: JSON.stringify({ error: 'Unknown skill' }), isError: true }
        : { content: text };
    }
    case 'search_products':
      return { content: JSON.stringify(searchProducts(catalog, input, state)) };
    case 'get_product_details':
      return productDetails(catalog, input, state);
    case 'search_policies':
      return { content: JSON.stringify(searchPolicies(catalog, input, state)) };
    case 'present_products': {
      const parsed = ProductsInput.safeParse(input);
      if (!parsed.success) {
        return invalid(parsed.error);
      }
      const { kept, dropped } = resolveIds(
        catalog,
        state,
        parsed.data.picks.map((pick) => pick.id),
      );
      const keptIds = new Set(kept.map((item) => item.d));
      const picks = parsed.data.picks
        .filter((pick) => keptIds.has(pick.id))
        .map((pick) => {
          const item = catalog.items.get(pick.id);
          return {
            address: item ? addressOf(item) : '',
            ...(pick.reason && clean(pick.reason, LIMITS.REASON_CHARS)
              ? { reason: clean(pick.reason, LIMITS.REASON_CHARS) }
              : {}),
          };
        });
      if (picks.length > 0) {
        state.components.push({
          type: 'products',
          ...(parsed.data.title && clean(parsed.data.title, LIMITS.TITLE_CHARS)
            ? { title: clean(parsed.data.title, LIMITS.TITLE_CHARS) }
            : {}),
          picks,
        });
      }
      return presentationResult(dropped, picks.length > 0);
    }
    case 'present_comparison': {
      const parsed = ComparisonInput.safeParse(input);
      if (!parsed.success) {
        return invalid(parsed.error);
      }
      // A product compared with itself is no comparison: duplicates count once.
      const uniqueIds = [...new Set(parsed.data.ids)];
      const { kept, dropped } = resolveIds(catalog, state, uniqueIds);
      if (kept.length < LIMITS.MIN_COMPARISON) {
        return presentationResult([...dropped, ...kept.map((item) => item.d)], false);
      }
      // Each kept product's cell is the one at its first position in the model's ids.
      const keptIndexes = kept.map((item) => parsed.data.ids.indexOf(item.d));
      const rows = [
        { dimension: PRICE_DIMENSION, cells: kept.map(priceCell) },
        // Cleaned first, filtered on what will actually be shown (NFKC folds lookalikes).
        ...parsed.data.rows
          .map((row) => ({
            dimension: clean(row.dimension, LIMITS.TITLE_CHARS),
            cells: keptIndexes.map(
              (index) => clean(row.cells[index] ?? '', LIMITS.REASON_CHARS) || '-',
            ),
          }))
          .filter(
            (row) =>
              row.dimension.length > 0 &&
              !PRICE_DIMENSION_RE.test(row.dimension) &&
              !row.cells.every((cell) => cell === '-' || isBareNumber(cell)),
          ),
      ];
      const recommendedItem =
        parsed.data.recommended !== undefined
          ? kept.find((item) => item.d === parsed.data.recommended)
          : undefined;
      state.components.push({
        type: 'comparison',
        ...(parsed.data.title && clean(parsed.data.title, LIMITS.TITLE_CHARS)
          ? { title: clean(parsed.data.title, LIMITS.TITLE_CHARS) }
          : {}),
        addresses: kept.map(addressOf),
        rows,
        ...(recommendedItem ? { recommended: addressOf(recommendedItem) } : {}),
      });
      return presentationResult(dropped, true);
    }
    case 'present_plan': {
      const parsed = PlanInput.safeParse(input);
      if (!parsed.success) {
        return invalid(parsed.error);
      }
      const allDropped: string[] = [];
      const steps = parsed.data.steps.map((step, stepIndex) => {
        const { kept, dropped } = resolveIds(catalog, state, step.ids);
        allDropped.push(...dropped);
        const detail = step.detail ? clean(step.detail, LIMITS.PLAN_DETAIL_CHARS) : '';
        return {
          label: clean(step.label, LIMITS.PLAN_STEP_LABEL_CHARS) || `${stepIndex + 1}`,
          ...(detail ? { detail } : {}),
          addresses: kept.map(addressOf),
        };
      });
      state.components.push({
        type: 'plan',
        title: clean(parsed.data.title, LIMITS.TITLE_CHARS) || '-',
        steps,
      });
      return presentationResult(allDropped, true);
    }
    case 'present_guide': {
      const parsed = GuideInput.safeParse(input);
      if (!parsed.success) {
        return invalid(parsed.error);
      }
      const sections = parsed.data.sections
        .map((section) => ({
          heading: clean(section.heading, LIMITS.TITLE_CHARS),
          body: clean(section.body, LIMITS.GUIDE_BODY_CHARS),
        }))
        .filter((section) => section.heading && section.body);
      if (sections.length === 0) {
        return { content: JSON.stringify({ error: 'Every section was empty.' }), isError: true };
      }
      state.components.push({
        type: 'guide',
        title: clean(parsed.data.title, LIMITS.TITLE_CHARS) || '-',
        sections,
      });
      return { content: JSON.stringify({ shown: true }) };
    }
    case 'present_suggestions': {
      const parsed = SuggestionsInput.safeParse(input);
      if (!parsed.success) {
        return invalid(parsed.error);
      }
      state.chips = parsed.data.chips
        .map((chip) => clean(chip, LIMITS.CHIP_CHARS))
        .filter((chip) => chip.length > 0)
        .slice(0, LIMITS.MAX_CHIPS);
      return { content: JSON.stringify({ shown: true }) };
    }
    default:
      return { content: JSON.stringify({ error: `Unknown tool ${call.name}` }), isError: true };
  }
}
