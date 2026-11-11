import { type Answer, fitAnswer } from '@elisym/comcore';
import type { StoreCatalog } from './catalog/store-catalog';
import { fence } from './fence';
import {
  type LlmMessage,
  type LlmProvider,
  type ToolResultBlock,
  type Usage,
  ZERO_USAGE,
  addUsage,
} from './llm/types';
import { type PriceViolation, checkPrices, stripViolations } from './price-check';
import { globalBlock, sessionBlock, storeBlock } from './prompt';
import { sanitizeAnswerText } from './text-sanitize';
import { TOOL_SPECS, executeTool, newTurnState } from './tools';

/** Tool rounds per turn before a forced no-tool round (5.5). */
export const MAX_TOOL_ROUNDS = 6;
const DEFAULT_MAX_TOKENS = 2_048;
const VISITOR_FENCE_CHARS = 4_000;

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
  /** The history to keep for the next turn: this turn's ask and final answer text. */
  history: LlmMessage[];
  /** Policy passages returned this turn, to add to the session's. */
  policyPassages: string[];
  /** What the price check removed after the re-run, if anything. */
  stripped: PriceViolation[];
}

function correctionMessage(violations: readonly PriceViolation[]): string {
  const quoted = violations.map((violation) => `- "${violation.text.slice(0, 200)}"`).join('\n');
  return `Your answer stated amounts that are not prices of the products you showed, a sum or difference of them, a policy amount or the visitor's own figure:\n${quoted}\nRewrite the answer without those amounts. Do not convert currencies or estimate prices; the cards show the prices.`;
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
  let usage = ZERO_USAGE;
  let modelCalls = 0;
  const policyPassages: string[] = [];

  const runLoop = async (messages: LlmMessage[]) => {
    const state = newTurnState(snapshotIds, policyPassages);
    let reportedStatuses = 0;
    for (let round = 0; ; round++) {
      const forceText = round >= MAX_TOOL_ROUNDS;
      const response = await input.provider.turn({
        system,
        messages,
        tools: TOOL_SPECS,
        toolChoice: forceText ? 'none' : 'auto',
        maxTokens,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      modelCalls += 1;
      usage = addUsage(usage, response.usage);
      if (response.toolCalls.length === 0 || forceText) {
        return { text: response.text, state, messages };
      }
      const results: ToolResultBlock[] = response.toolCalls.map((call) => {
        const outcome = executeTool(input.catalog, state, call);
        return {
          type: 'tool_result',
          toolUseId: call.id,
          content: outcome.content,
          ...(outcome.isError ? { isError: true } : {}),
        };
      });
      while (reportedStatuses < state.statuses.length) {
        const line = state.statuses[reportedStatuses];
        reportedStatuses += 1;
        if (line !== undefined) {
          input.onStatus?.(line);
        }
      }
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: [
            ...(response.text ? [{ type: 'text' as const, text: response.text }] : []),
            ...response.toolCalls,
          ],
        },
        { role: 'user', content: results },
      ];
    }
  };

  const toAnswer = (text: string, state: ReturnType<typeof newTurnState>): Answer =>
    fitAnswer(
      {
        type: 'answer',
        ask_id: input.askId,
        session_end: input.sessionEnd,
        text: sanitizeAnswerText(text).slice(0, 4_000),
        components: state.components.slice(0, 4),
        chips: state.chips,
      },
      input.now,
    );

  const checkContext = () => ({
    storeCurrency: input.catalog.config.currency,
    items: input.catalog.items,
    visitorMessages: [...input.earlierVisitorMessages, input.text],
    policyPassages: [...input.earlierPolicyPassages, ...policyPassages],
    locales: [input.locale ?? 'en', input.catalog.config.language],
  });

  const first = await runLoop([...input.history, visitorMessage]);
  let answer = toAnswer(first.text, first.state);
  let violations = checkPrices(answer, checkContext());
  let stripped: PriceViolation[] = [];
  if (violations.length > 0) {
    const retry = await runLoop([
      ...first.messages,
      { role: 'assistant', content: [{ type: 'text', text: first.text || '(no text)' }] },
      { role: 'user', content: [{ type: 'text', text: correctionMessage(violations) }] },
    ]);
    answer = toAnswer(retry.text, retry.state);
    violations = checkPrices(answer, checkContext());
    if (violations.length > 0) {
      stripped = violations;
      answer = stripViolations(answer, violations);
    }
  }
  return {
    answer,
    usage,
    modelCalls,
    history: [
      ...input.history,
      visitorMessage,
      { role: 'assistant', content: [{ type: 'text', text: answer.text || '(shown cards)' }] },
    ],
    policyPassages,
    stripped,
  };
}
