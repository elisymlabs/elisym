import {
  type CatalogItemInput,
  type Policy,
  type StoreConfig,
  buildCatalogItemEvent,
  parseCatalogItem,
} from '@elisym/comcore';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { StoreCatalog } from '../src/catalog/store-catalog';
import type { LlmProvider, ToolUseBlock, TurnRequest, TurnResponse } from '../src/llm/types';

export const NOW = 1_800_000_000;
const catalogSecret = generateSecretKey();
export const CATALOG_KEY = getPublicKey(catalogSecret);

export function item(input: CatalogItemInput) {
  const parsed = parseCatalogItem(finalizeEvent(buildCatalogItemEvent(input), catalogSecret), {
    now: NOW,
    role: 'catalog',
  });
  if (!parsed) {
    throw new Error(`fixture item ${input.d} did not parse`);
  }
  return parsed;
}

export const CONFIG: StoreConfig = {
  owner: '1'.repeat(64),
  assistant: '2'.repeat(64),
  origins: ['https://shop.example.com'],
  linkOrigins: [],
  name: 'Example Shop',
  language: 'en',
  currency: 'USD',
  source: { kind: 'catalog' },
  catalogKey: CATALOG_KEY,
  policyKey: CATALOG_KEY,
  privateContent: '',
  createdAt: NOW,
};

export const ITEMS = [
  item({
    d: 'jacket-wool',
    title: 'Wool jacket',
    description: 'Warm wool jacket for winter.',
    price: { amount: '120', currency: 'USD' },
    url: 'https://shop.example.com/products/jacket-wool',
    attrs: [{ name: 'material', value: 'wool' }],
    topics: ['jackets'],
  }),
  item({
    d: 'jacket-rain',
    title: 'Rain jacket',
    description: 'Light waterproof shell.',
    price: { amount: '79.90', currency: 'USD' },
    url: 'https://shop.example.com/products/jacket-rain',
    attrs: [{ name: 'material', value: 'nylon' }],
    topics: ['jackets'],
  }),
  item({
    d: 'scarf',
    title: 'Knit scarf',
    description: 'A warm knit scarf.',
    price: { amount: '25', currency: 'USD' },
    url: 'https://shop.example.com/products/scarf',
    topics: ['accessories'],
    options: [{ name: 'color', values: ['red', 'grey'] }],
    variants: [
      { id: 'scarf-red', price: '25', available: true, values: ['red'] },
      { id: 'scarf-grey', price: '25', available: false, values: ['grey'] },
    ],
  }),
  item({
    d: 'box',
    title: 'Coffee box',
    description: 'Monthly coffee delivery.',
    price: { amount: '15', currency: 'USD', frequency: 'month' },
    topics: ['coffee'],
  }),
  item({
    d: 'euro-mug',
    title: 'Euro mug',
    description: 'Priced in euros.',
    price: { amount: '9', currency: 'EUR' },
  }),
];

export const POLICIES: Policy[] = [
  {
    author: CATALOG_KEY,
    slug: 'shipping',
    title: 'Shipping',
    body: 'Free shipping in the US over $50. EU shipping €15.',
    createdAt: NOW,
  },
];

export function catalog(): StoreCatalog {
  return new StoreCatalog(
    CONFIG,
    { voice: 'friendly', instructions: '', notes: '' },
    ITEMS,
    POLICIES,
  );
}

let callId = 0;
export function toolCall(name: string, input: Record<string, unknown>): ToolUseBlock {
  callId += 1;
  return { type: 'tool_use', id: `call_${callId}`, name, input };
}

/** A provider that replays scripted responses and records the requests. */
export function scripted(steps: Array<{ text?: string; calls?: ToolUseBlock[] }>) {
  const requests: TurnRequest[] = [];
  let index = 0;
  const provider: LlmProvider = {
    model: 'scripted',
    async turn(request: TurnRequest): Promise<TurnResponse> {
      requests.push(request);
      const step = steps[Math.min(index, steps.length - 1)] ?? {};
      index += 1;
      return {
        text: step.text ?? '',
        toolCalls: request.toolChoice === 'none' ? [] : (step.calls ?? []),
        stopReason: 'end_turn',
        usage: { inputTokens: 100, cachedInputTokens: 50, cacheWriteTokens: 0, outputTokens: 20 },
      };
    },
  };
  return { provider, requests };
}
