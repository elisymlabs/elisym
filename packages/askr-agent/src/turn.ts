import { type Answer, LIMITS, fitAnswer, parseAddress } from '@elisym/askr';
import type { StoreCatalog } from './catalog/store-catalog';
import { fence, sanitizeText } from './fence';
import {
  type ContentBlock,
  DECLINED_STOP_REASONS,
  type LlmMessage,
  TRUNCATED_STOP_REASONS,
  type LlmProvider,
  type ToolResultBlock,
  type Usage,
  ZERO_USAGE,
  addUsage,
} from './llm/types';
import { type PriceViolation, cardsPointer, checkPrices, stripViolations } from './price-check';
import { globalBlock, sessionBlock, storeBlock } from './prompt';
import { sanitizeAnswerText } from './text-sanitize';
import { TOOL_SPECS, type TurnState, executeTool, newTurnState } from './tools';

/** Tool rounds per turn before a forced no-tool round (5.5). */
export const MAX_TOOL_ROUNDS = 6;
const DEFAULT_MAX_TOKENS = 2_048;
const VISITOR_FENCE_CHARS = 4_000;
const MAX_STRIP_PASSES = 32;

export interface TurnInput {
  catalog: StoreCatalog;
  provider: LlmProvider;
  /** Prior turns of this session, as returned by earlier `runTurn` calls. */
  history: LlmMessage[];
  askId: string;
  text: string;
  pageUrl?: string;
  locale?: string;
  /** Unix seconds: the session end the answer carries (4.4). */
  sessionEnd: number;
  /** The assistant's clock for size measurement. */
  now: number;
  /** Every earlier visitor message of the session (the price check allows quoting them, 5.5). */
  earlierVisitorMessages: readonly string[];
  /** Policy passages returned earlier in the session. */
  earlierPolicyPassages: readonly string[];
  /** Ids tools returned earlier in the session: still presentable (5.5). */
  earlierAllowedIds?: readonly string[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with each status line as tools produce it (at most 2 per turn, 4.2). */
  onStatus?: (text: string) => void;
}

export interface TurnOutput {
  answer: Answer;
  usage: Usage;
  /** Model calls made, including the price-check re-run. */
  modelCalls: number;
  /** The history to keep for the next turn: this turn's ask and a note of the answer. */
  history: LlmMessage[];
  /** Policy passages returned this turn, to add to the session's. */
  policyPassages: string[];
  /** Ids tools returned this turn (and earlier), to keep for the session. */
  allowedIds: string[];
  /** What the price check removed after the re-run, if anything. */
  stripped: PriceViolation[];
}

/** A turn that ended without an answer; carries what it already spent (5.8 settles it). */
export class TurnError extends Error {
  constructor(
    readonly reason: unknown,
    readonly usage: Usage,
    readonly modelCalls: number,
  ) {
    super(reason instanceof Error ? reason.message : 'The turn failed');
    this.name = 'TurnError';
  }
}

/**
 * The final assistant turn as sent back before the price-check correction: as
 * returned, thinking included, when it is a plain answer. A forced round the
 * model answered with tool calls anyway cannot go back as is (a tool_use needs
 * its result), so it is rebuilt from the text.
 */
function replayOf(content: readonly ContentBlock[], text: string): ContentBlock[] {
  const plain = { type: 'text' as const, text: text || '(no text)' };
  if (content.some((block) => block.type === 'tool_use')) {
    return [plain];
  }
  return content.some((block) => block.type === 'text') ? [...content] : [...content, plain];
}

function correctionMessage(violations: readonly PriceViolation[]): string {
  const quoted = violations.map((violation) => `- "${violation.text.slice(0, 200)}"`).join('\n');
  return `Your answer stated amounts that are not prices of the products you showed or named, a sum or difference of them, a policy amount or the visitor's own figure:\n${quoted}\nRewrite the answer without those amounts. Keep the cards you already showed unless they were wrong. Do not convert currencies or estimate prices; the cards show the prices.`;
}

/** The assistant history entry: the text plus which products were shown, so "the second one" resolves. */
function historyNote(answer: Answer, catalog: StoreCatalog): string {
  const shown = answer.components.flatMap((component) => {
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
  const named = [...new Set(shown.map((address) => parseAddress(address)?.d ?? ''))]
    .filter((productId) => productId.length > 0)
    .map(
      (productId, index) =>
        `${index + 1}. ${productId} (${sanitizeText(catalog.items.get(productId)?.title ?? productId, LIMITS.TITLE_CHARS)})`,
    );
  const shownLine = named.length > 0 ? `\n[shown, in order: ${named.join('; ')}]` : '';
  return `${answer.text || '(cards only)'}${shownLine}`;
}

/**
 * One turn: the model loop with tools and gates, then the answer, fitted to
 * the size cap and checked for prices (re-run once, then stripped). Pure: no
 * relay, no DB; the server owns sessions, budgets and publishing (5.8).
 */
export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  const { block: store, snapshotIds } = storeBlock(input.catalog);
  const system = [globalBlock(), store, sessionBlock(input.catalog, input.pageUrl, input.locale)];
  const visitorMessage: LlmMessage = {
    role: 'user',
    content: [{ type: 'text', text: fence('visitor', input.text, VISITOR_FENCE_CHARS) }],
  };
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const locale = input.locale ?? 'en';
  let usage = ZERO_USAGE;
  let modelCalls = 0;
  const policyPassages: string[] = [];
  // Turn-scoped: the re-run keeps the ids the first loop earned, and the status cap spans both.
  const allowedIds = new Set<string>([...snapshotIds, ...(input.earlierAllowedIds ?? [])]);
  const statuses: string[] = [];
  let reportedStatuses = 0;
  // Tool rounds are counted per turn, across the corrective re-run (5.5).
  let toolRounds = 0;

  const runLoop = async (start: LlmMessage[]) => {
    const state = newTurnState(allowedIds, policyPassages, statuses);
    let messages = start;
    for (;;) {
      const forceText = toolRounds >= MAX_TOOL_ROUNDS;
      const response = await input.provider.turn({
        system,
        messages,
        tools: TOOL_SPECS,
        toolChoice: forceText ? 'none' : 'auto',
        maxTokens,
        cacheLastMessage: true,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      modelCalls += 1;
      usage = addUsage(usage, response.usage);
      // Fail closed: a cut-off text or tool call is no answer, and neither is a declined one.
      if (TRUNCATED_STOP_REASONS.includes(response.stopReason)) {
        throw new Error(`The model stopped at max_tokens (${response.stopReason})`);
      }
      if (DECLINED_STOP_REASONS.includes(response.stopReason)) {
        throw new Error(`The model declined the request (${response.stopReason})`);
      }
      // Sent back unchanged in this turn: thinking blocks stay with the tool calls they led to.
      const assistantContent: ContentBlock[] = response.assistantContent ?? [
        ...(response.text ? [{ type: 'text' as const, text: response.text }] : []),
        ...response.toolCalls,
      ];
      // A model that still calls tools on the forced round is not obeyed: its text is the answer.
      if (response.toolCalls.length === 0 || forceText) {
        return { text: response.text, state, messages, assistantContent };
      }
      toolRounds += 1;
      const results: ToolResultBlock[] = response.toolCalls.map((call) => {
        const outcome = executeTool(input.catalog, state, call);
        return {
          type: 'tool_result',
          toolUseId: call.id,
          content: outcome.content,
          ...(outcome.isError ? { isError: true } : {}),
        };
      });
      while (reportedStatuses < statuses.length) {
        const line = statuses[reportedStatuses];
        reportedStatuses += 1;
        if (line !== undefined) {
          input.onStatus?.(line);
        }
      }
      messages = [
        ...messages,
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: results },
      ];
    }
  };

  const toAnswer = (text: string, state: TurnState): Answer =>
    fitAnswer(
      {
        type: 'answer',
        ask_id: input.askId,
        session_end: input.sessionEnd,
        text: sanitizeAnswerText(text).slice(0, LIMITS.ANSWER_TEXT_CHARS),
        components: state.components.slice(0, LIMITS.MAX_COMPONENTS),
        chips: state.chips,
      },
      input.now,
    );

  const checkContext = () => ({
    storeCurrency: input.catalog.config.currency,
    items: input.catalog.items,
    visitorMessages: [...input.earlierVisitorMessages, input.text],
    policyPassages: [...input.earlierPolicyPassages, ...policyPassages],
    locales: [locale, input.catalog.config.language],
  });

  let answer: Answer;
  let stripped: PriceViolation[] = [];
  try {
    const first = await runLoop([...input.history, visitorMessage]);
    answer = toAnswer(first.text, first.state);
    let violations = checkPrices(answer, checkContext());
    if (violations.length > 0) {
      const retry = await runLoop([
        ...first.messages,
        { role: 'assistant', content: replayOf(first.assistantContent, first.text) },
        { role: 'user', content: [{ type: 'text', text: correctionMessage(violations) }] },
      ]);
      // A re-run that only rewrites its text keeps what it did not redo, field by field.
      const retryState: TurnState = {
        ...retry.state,
        components:
          retry.state.components.length > 0 ? retry.state.components : first.state.components,
        chips: retry.state.chips.length > 0 ? retry.state.chips : first.state.chips,
      };
      answer = toAnswer(retry.text, retryState);
      violations = checkPrices(answer, checkContext());
      // Strip until the check passes: removing a sentence can let a kept one borrow a symbol it
      // did not before ("1200 Rs." then "999 people"), and removing a component removes the
      // items it cited. Every pass removes at least one string, so this ends; the bound guards.
      for (let pass = 0; violations.length > 0 && pass < MAX_STRIP_PASSES; pass += 1) {
        stripped = [...stripped, ...violations];
        // The appended pointer can lengthen the text: cut and fit again.
        const cleaned = stripViolations(answer, violations, locale);
        answer = fitAnswer(
          { ...cleaned, text: cleaned.text.slice(0, LIMITS.ANSWER_TEXT_CHARS) },
          input.now,
        );
        violations = checkPrices(answer, checkContext());
      }
      // Fail closed should the bound ever be reached: no model-written text at all.
      if (violations.length > 0) {
        stripped = [...stripped, ...violations];
        answer = fitAnswer(
          { ...answer, text: cardsPointer(locale), components: [], chips: [] },
          input.now,
        );
      }
    }
  } catch (error) {
    throw new TurnError(error, usage, modelCalls);
  }
  return {
    answer,
    usage,
    modelCalls,
    history: [
      ...input.history,
      visitorMessage,
      { role: 'assistant', content: [{ type: 'text', text: historyNote(answer, input.catalog) }] },
    ],
    policyPassages,
    allowedIds: [...allowedIds],
    stripped,
  };
}
