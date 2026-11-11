/**
 * Snapshot evals (spec 8): build the state, append the visitor message, run one
 * turn against a real model, grade the final answer with deterministic checks.
 *
 *   ANTHROPIC_API_KEY=... bun packages/comcore-agent/evals/run.ts --model claude-sonnet-5-5
 *   OPENROUTER_API_KEY=... bun packages/comcore-agent/evals/run.ts --openrouter deepseek/deepseek-chat
 *
 * Not part of `bun qa`: it calls a paid API.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CatalogItemInput,
  type StoreConfig,
  buildCatalogItemEvent,
  parseCatalogItem,
  parseAddress,
} from '@elisym/comcore';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  StoreCatalog,
  checkPrices,
  createAnthropicProvider,
  createOpenAiCompatibleProvider,
  runTurn,
} from '../src';

interface EvalCase {
  id: string;
  category: string;
  message: string;
  page?: string;
  locale?: string;
  history?: string[];
  expect: {
    /** At least one of these ids is presented. */
    presentsAny?: string[];
    /** None of these ids is presented. */
    presentsNone?: string[];
    /** The answer text matches (case-insensitive regex). */
    textMatches?: string;
    /** The answer text must not match. */
    textNotMatches?: string;
    /** No component at all (a pure text answer). */
    noComponents?: boolean;
  };
}

interface EvalStore {
  config: Omit<
    StoreConfig,
    'catalogKey' | 'policyKey' | 'createdAt' | 'privateContent' | 'owner' | 'assistant'
  >;
  private?: { voice: string; instructions: string; notes: string };
  items: CatalogItemInput[];
  policies: { slug: string; title: string; body: string }[];
}

const here = dirname(fileURLToPath(import.meta.url));
const store: EvalStore = JSON.parse(readFileSync(join(here, 'store.json'), 'utf8'));
const cases: EvalCase[] = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const NOW = Math.floor(Date.now() / 1000);
const secret = generateSecretKey();
const key = getPublicKey(secret);

const items = store.items.flatMap((input) => {
  const parsed = parseCatalogItem(finalizeEvent(buildCatalogItemEvent(input), secret), {
    now: NOW,
    role: 'catalog',
  });
  return parsed ? [parsed] : [];
});
const catalog = new StoreCatalog(
  {
    ...store.config,
    owner: key,
    assistant: key,
    catalogKey: key,
    policyKey: key,
    privateContent: '',
    createdAt: NOW,
  },
  store.private,
  items,
  store.policies.map((policy) => ({ ...policy, author: key, createdAt: NOW })),
);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const openRouterModel = flag('--openrouter');
const provider = openRouterModel
  ? createOpenAiCompatibleProvider({
      apiKey: process.env.OPENROUTER_API_KEY ?? '',
      model: openRouterModel,
      baseUrl: 'https://openrouter.ai/api/v1',
      passCacheMarks: openRouterModel.startsWith('anthropic/'),
      extraBody: { provider: { data_collection: 'deny' } },
    })
  : createAnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: flag('--model') ?? 'claude-haiku-5-5',
    });

let passed = 0;
for (const testCase of cases) {
  const output = await runTurn({
    catalog,
    provider,
    history: (testCase.history ?? []).flatMap((text, index) => [
      {
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: [{ type: 'text' as const, text }],
      },
    ]),
    askId: '0'.repeat(32),
    text: testCase.message,
    ...(testCase.page ? { pageUrl: testCase.page } : {}),
    ...(testCase.locale ? { locale: testCase.locale } : {}),
    sessionEnd: NOW + 3_600,
    now: NOW,
    earlierVisitorMessages: (testCase.history ?? []).filter((_text, index) => index % 2 === 0),
    earlierPolicyPassages: [],
  });
  const presented = output.answer.components
    .flatMap((component) =>
      component.type === 'products'
        ? component.picks.map((pick) => pick.address)
        : component.type === 'comparison'
          ? component.addresses
          : component.type === 'plan'
            ? component.steps.flatMap((step) => step.addresses)
            : [],
    )
    .map((address) => parseAddress(address)?.d ?? '');
  const failures: string[] = [];
  const { expect } = testCase;
  if (expect.presentsAny && !expect.presentsAny.some((id) => presented.includes(id))) {
    failures.push(
      `expected one of ${expect.presentsAny.join(', ')}, presented ${presented.join(', ') || 'nothing'}`,
    );
  }
  for (const id of expect.presentsNone ?? []) {
    if (presented.includes(id)) {
      failures.push(`presented forbidden ${id}`);
    }
  }
  if (expect.textMatches && !new RegExp(expect.textMatches, 'i').test(output.answer.text)) {
    failures.push(`text does not match /${expect.textMatches}/`);
  }
  if (expect.textNotMatches && new RegExp(expect.textNotMatches, 'i').test(output.answer.text)) {
    failures.push(`text matches forbidden /${expect.textNotMatches}/`);
  }
  if (expect.noComponents && output.answer.components.length > 0) {
    failures.push('expected no components');
  }
  if (output.stripped.length > 0) {
    failures.push(`price check stripped ${output.stripped.length} string(s) after the re-run`);
  }
  const residual = checkPrices(output.answer, {
    storeCurrency: catalog.config.currency,
    items: catalog.items,
    visitorMessages: [testCase.message],
    policyPassages: store.policies.map((policy) => policy.body),
    locales: [testCase.locale ?? 'en', catalog.config.language],
  });
  if (residual.length > 0) {
    failures.push('price check still fails on the final answer');
  }
  const ok = failures.length === 0;
  passed += ok ? 1 : 0;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${testCase.id} [${testCase.category}] calls=${output.modelCalls} in=${output.usage.inputTokens} cached=${output.usage.cachedInputTokens} out=${output.usage.outputTokens}${ok ? '' : `\n  ${failures.join('\n  ')}\n  text: ${output.answer.text.slice(0, 300)}`}`,
  );
}
console.log(`\n${passed}/${cases.length} passed`);
