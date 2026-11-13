/**
 * Snapshot eval harness (spec 8): build the store's catalog, build a case's
 * state (page URL, history), append the visitor message, run one turn against
 * any provider and record what came back. Grading is in `grade.ts`.
 */
import {
  type Answer,
  type Policy,
  type StoreConfig,
  buildCatalogItemEvent,
  parseAddress,
  parseCatalogItem,
} from '@elisym/askr';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { StoreCatalog } from '../src/catalog/store-catalog';
import { fence } from '../src/fence';
import { type LlmMessage, type LlmProvider, type Usage, ZERO_USAGE } from '../src/llm/types';
import { TurnError, runTurn } from '../src/turn';
import type { EvalCase, EvalStore } from './cases';

/** Visitor messages in a history are fenced exactly as `runTurn` fences live ones. */
const VISITOR_FENCE_CHARS = 4_000;
const ASK_ID = '0'.repeat(32);
const SESSION_SECONDS = 3_600;

export interface BuiltCatalog {
  catalog: StoreCatalog;
  /** Product ids that did not survive signing and parsing, or were dropped for their currency. */
  rejected: string[];
}

/** Sign every listing with a throwaway key and build the catalog the agent reads. */
export function buildCatalog(store: EvalStore, now: number): BuiltCatalog {
  const secret = generateSecretKey();
  const key = getPublicKey(secret);
  const rejected: string[] = [];
  const items = store.items.flatMap((input) => {
    const parsed = parseCatalogItem(finalizeEvent(buildCatalogItemEvent(input), secret), {
      now,
      role: 'catalog',
    });
    if (!parsed) {
      rejected.push(input.d);
      return [];
    }
    return [parsed];
  });
  const config: StoreConfig = {
    ...store.config,
    linkOrigins: store.config.linkOrigins ?? [],
    owner: key,
    assistant: key,
    catalogKey: key,
    policyKey: key,
    privateContent: '',
    createdAt: now,
  };
  const policies: Policy[] = store.policies.map((policy) => ({
    ...policy,
    author: key,
    createdAt: now,
  }));
  const catalog = new StoreCatalog(config, store.private, items, policies);
  return { catalog, rejected: [...rejected, ...catalog.otherCurrency] };
}

/** The ids an answer presents, in order, without repeats. */
export function presentedIds(answer: Answer): string[] {
  const addresses = answer.components.flatMap((component) => {
    switch (component.type) {
      case 'products':
        return component.picks.map((pick) => pick.address);
      case 'comparison':
        return component.addresses;
      case 'plan':
        return component.steps.flatMap((step) => step.addresses);
      case 'guide':
        return [];
    }
  });
  const ids = addresses
    .map((address) => parseAddress(address)?.d ?? '')
    .filter((productId) => productId.length > 0);
  return [...new Set(ids)];
}

export function historyMessages(history: readonly string[]): LlmMessage[] {
  return history.map((text, index) =>
    index % 2 === 0
      ? {
          role: 'user',
          content: [{ type: 'text', text: fence('visitor', text, VISITOR_FENCE_CHARS) }],
        }
      : { role: 'assistant', content: [{ type: 'text', text }] },
  );
}

export class CallTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The model call timed out after ${timeoutMs} ms`);
    this.name = 'CallTimeoutError';
  }
}

/**
 * Every model call gets its own deadline: the signal aborts the request, and
 * the race settles even a provider that ignores the signal, so one hung call
 * cannot stall the sweep.
 */
export function withCallTimeout(provider: LlmProvider, timeoutMs: number): LlmProvider {
  return {
    model: provider.model,
    async turn(request) {
      const controller = new AbortController();
      const signal = request.signal
        ? AbortSignal.any([request.signal, controller.signal])
        : controller.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new CallTimeoutError(timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      try {
        return await Promise.race([provider.turn({ ...request, signal }), deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface CaseOutcome {
  caseId: string;
  category: string;
  /** 1-based repeat number. */
  repeat: number;
  text: string;
  presented: string[];
  componentCount: number;
  /** Strings the price check still removed after its corrective re-run. */
  strippedCount: number;
  usage: Usage;
  modelCalls: number;
  /** Wall time of `runTurn`, ms (answers are not streamed: this is the time to the answer). */
  latencyMs: number;
  /** Set when the turn ended without an answer. */
  error?: string;
}

export interface RunCaseInput {
  catalog: StoreCatalog;
  provider: LlmProvider;
  testCase: EvalCase;
  now: number;
  repeat?: number;
  /** A monotonic clock in ms; `performance.now` by default. */
  clock?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCase(input: RunCaseInput): Promise<CaseOutcome> {
  const { testCase, catalog } = input;
  const clock = input.clock ?? (() => performance.now());
  const history = testCase.history ?? [];
  const passages = (testCase.earlierPolicies ?? []).flatMap((slug) =>
    catalog.policies.filter((policy) => policy.slug === slug).map((policy) => policy.body),
  );
  const base = {
    caseId: testCase.id,
    category: testCase.category,
    repeat: input.repeat ?? 1,
  };
  const started = clock();
  try {
    const output = await runTurn({
      catalog,
      provider: input.provider,
      history: historyMessages(history),
      askId: ASK_ID,
      text: testCase.message,
      ...(testCase.page ? { pageUrl: testCase.page } : {}),
      ...(testCase.locale ? { locale: testCase.locale } : {}),
      sessionEnd: input.now + SESSION_SECONDS,
      now: input.now,
      earlierVisitorMessages: history.filter((_text, index) => index % 2 === 0),
      earlierPolicyPassages: passages,
    });
    return {
      ...base,
      text: output.answer.text,
      presented: presentedIds(output.answer),
      componentCount: output.answer.components.length,
      strippedCount: output.stripped.length,
      usage: output.usage,
      modelCalls: output.modelCalls,
      latencyMs: Math.round(clock() - started),
    };
  } catch (error) {
    const latencyMs = Math.round(clock() - started);
    const spent = error instanceof TurnError ? error : undefined;
    const reason = error instanceof TurnError ? error.reason : error;
    return {
      ...base,
      text: '',
      presented: [],
      componentCount: 0,
      strippedCount: 0,
      usage: spent?.usage ?? ZERO_USAGE,
      modelCalls: spent?.modelCalls ?? 0,
      latencyMs,
      error: errorMessage(reason),
    };
  }
}
