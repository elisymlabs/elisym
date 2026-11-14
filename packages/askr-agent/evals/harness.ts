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
import {
  type LlmMessage,
  type LlmProvider,
  LlmError,
  type Usage,
  ZERO_USAGE,
} from '../src/llm/types';
import { type StopKind, StopReasonError, TurnError, runTurn } from '../src/turn';
import type { EvalCase, EvalStore } from './cases';

/** Visitor messages in a history are fenced exactly as `runTurn` fences live ones. */
const VISITOR_FENCE_CHARS = 4_000;
const ASK_ID = '0'.repeat(32);
const SESSION_SECONDS = 3_600;
/** The store writes this comparison row itself (src/tools.ts): not model text. */
const STORE_PRICE_DIMENSION = 'Price';
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;
/** What fetch rejects with when the network fails (Node, browsers, Safari) or a socket code. */
const NETWORK_MESSAGE_RE = /fetch failed|failed to fetch|network|load failed|socket|connection/i;
const NETWORK_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'ConnectionRefused',
  'ConnectionClosed',
];

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

/** One string the model wrote into a component or a chip, labeled by where it shows. */
export interface WrittenString {
  label: string;
  text: string;
}

function idOf(address: string): string {
  return parseAddress(address)?.d ?? address;
}

function written(label: string, text: string | undefined): WrittenString[] {
  return text === undefined || text.length === 0 || text === '-' ? [] : [{ label, text }];
}

/**
 * Every string the model wrote into the components and chips: titles, pick
 * reasons, comparison dimensions and cells (not the store's price row), plan
 * labels and details, guide headings and bodies. They reach the visitor like
 * the text, so text checks and the judge read them too.
 */
export function modelStrings(answer: Answer): WrittenString[] {
  const strings = answer.components.flatMap((component) => {
    switch (component.type) {
      case 'products':
        return [
          ...written('cards title', component.title),
          ...component.picks.flatMap((pick) =>
            written(`pick reason (${idOf(pick.address)})`, pick.reason),
          ),
        ];
      case 'comparison':
        return [
          ...written('comparison title', component.title),
          ...component.rows
            .filter((row) => row.dimension !== STORE_PRICE_DIMENSION)
            .flatMap((row) => [
              ...written('comparison row', row.dimension),
              ...row.cells.flatMap((cell, index) =>
                written(
                  `comparison cell (${row.dimension}, ${idOf(component.addresses[index] ?? '')})`,
                  cell,
                ),
              ),
            ]),
        ];
      case 'plan':
        return [
          ...written('plan title', component.title),
          ...component.steps.flatMap((step) => [
            ...written('plan step', step.label),
            ...written('plan step detail', step.detail),
          ]),
        ];
      case 'guide':
        return [
          ...written('guide title', component.title),
          ...component.sections.flatMap((section) => [
            ...written('guide heading', section.heading),
            ...written('guide body', section.body),
          ]),
        ];
    }
  });
  return [...strings, ...answer.chips.flatMap((chip) => written('chip', chip))];
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

/** A model call that still failed after its retries: the provider's fault, not the answer's. */
export class ProviderError extends Error {
  constructor(
    readonly reason: unknown,
    readonly attempts: number,
  ) {
    super(
      `provider error after ${attempts} attempt(s): ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    this.name = 'ProviderError';
  }
}

/** A network failure, not any TypeError: a bug that throws one is not retried as a network error. */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (NETWORK_CODES.includes(code)) {
    return true;
  }
  return error instanceof TypeError && NETWORK_MESSAGE_RE.test(error.message);
}

/** Worth another try: 408, 429, server errors, timeouts and network failures. */
export function isTransient(error: unknown): boolean {
  if (error instanceof LlmError) {
    return (
      error.status === HTTP_REQUEST_TIMEOUT ||
      error.status === HTTP_TOO_MANY_REQUESTS ||
      (error.status !== undefined && error.status >= HTTP_SERVER_ERROR)
    );
  }
  return error instanceof CallTimeoutError || isNetworkError(error);
}

/**
 * A 4xx other than 408 and 429 (a bad key, an unknown model, a refused route):
 * the same on every attempt, so the fix is the configuration, not a rerun.
 */
export function isConfigError(error: unknown): boolean {
  return (
    error instanceof LlmError &&
    error.status !== undefined &&
    error.status >= HTTP_CLIENT_ERROR &&
    error.status < HTTP_SERVER_ERROR &&
    !isTransient(error)
  );
}

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  /** The first backoff; each later one doubles, up to `maxDelayMs`. */
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called for every failed attempt, the last one too: its usage is unknown. */
  onFailedAttempt?: (error: unknown) => void;
}

export const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 2_000, maxDelayMs: 30_000 };

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The backoff before retry `retry` (1-based). */
export function backoffMs(retry: number, options: RetryOptions): number {
  return Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (retry - 1));
}

/**
 * Retry transient failures with bounded exponential backoff. Any failure that
 * remains is a `ProviderError`, so the sweep tells a provider outage from a
 * bad answer. The adapters surface only the status, so there is no
 * retry-after to honor: a 429 waits the same backoff.
 */
export function withRetries(provider: LlmProvider, options: RetryOptions): LlmProvider {
  const sleep = options.sleep ?? sleepFor;
  return {
    model: provider.model,
    async turn(request) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await provider.turn(request);
        } catch (error) {
          options.onFailedAttempt?.(error);
          if (attempt > options.retries || !isTransient(error)) {
            throw new ProviderError(error, attempt);
          }
          await sleep(backoffMs(attempt, options));
        }
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
  /** Model-written component strings and chips (`modelStrings`). */
  strings: WrittenString[];
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
  /** The turn ended on a model call that failed after its retries. */
  providerError?: boolean;
  /** ...and that call's last attempt timed out. */
  timedOut?: boolean;
  /** ...and the failure is a 4xx that will not change on a rerun: fix the route or model. */
  configError?: boolean;
  /** The turn ended on the model's stop reason: cut at max_tokens, declined, or another. */
  stopKind?: StopKind;
}

export interface RunCaseInput {
  catalog: StoreCatalog;
  provider: LlmProvider;
  testCase: EvalCase;
  now: number;
  repeat?: number;
  /** max_tokens per model call (thinking included); runTurn's default when absent. */
  maxTokens?: number;
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
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    });
    return {
      ...base,
      text: output.answer.text,
      strings: modelStrings(output.answer),
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
      strings: [],
      presented: [],
      componentCount: 0,
      strippedCount: 0,
      usage: spent?.usage ?? ZERO_USAGE,
      modelCalls: spent?.modelCalls ?? 0,
      latencyMs,
      error: errorMessage(reason),
      ...(reason instanceof StopReasonError ? { stopKind: reason.kind } : {}),
      ...(reason instanceof ProviderError
        ? {
            providerError: true,
            timedOut: reason.reason instanceof CallTimeoutError,
            configError: isConfigError(reason.reason),
          }
        : {}),
    };
  }
}
