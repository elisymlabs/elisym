/**
 * Mock LLM client for local capacity tests (Phase 7 of perf plan).
 *
 * Activated by `MOCK_LLM=1`. Refuses to start when `NODE_ENV=production`
 * so a misconfigured deployment cannot accidentally serve mock answers.
 *
 * Tunables (env):
 *   MOCK_LLM_LATENCY_MS=0           constant base latency before reply
 *   MOCK_LLM_JITTER_MS=200          uniform jitter [0, jitter] added to base
 *   MOCK_LLM_BILLING_FAIL_PCT=0     percent of calls that throw a billing
 *                                   error string the runtime classifier
 *                                   recognizes (used to exercise the LLM
 *                                   health-gate without burning real credits)
 *
 * The mock implements the SDK `LlmClient` interface verbatim. Tools are not
 * exercised - capacity tests focus on the request/response cycle, not on
 * multi-round tool-use loops.
 */
import type { CompletionResult, LlmClient, ToolDef, ToolResult } from '@elisym/sdk/skills';

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function delayMs(): number {
  // Re-read env on each call so test runs (and live edits during dev) take
  // effect without restarting the process. The mock is dev-only; per-call
  // env read overhead is negligible.
  return (
    parseEnvNumber('MOCK_LLM_LATENCY_MS', 0) +
    Math.random() * parseEnvNumber('MOCK_LLM_JITTER_MS', 200)
  );
}

function maybeThrowBilling(): void {
  const pct = parseEnvNumber('MOCK_LLM_BILLING_FAIL_PCT', 0);
  if (pct <= 0) {
    return;
  }
  if (Math.random() * 100 < pct) {
    // String shape mirrors the real provider error format the runtime
    // classifier (runtime.ts BILLING_BODY_MARKERS) keys on.
    throw new Error(
      'Mock provider API error: 402 credit balance exhausted (MOCK_LLM_BILLING_FAIL_PCT)',
    );
  }
}

function syntheticReply(systemPrompt: string, userInput: string): string {
  const promptHead = systemPrompt.slice(0, 60).replace(/\s+/g, ' ').trim();
  const inputHead = userInput.slice(0, 80).replace(/\s+/g, ' ').trim();
  return `MOCK_LLM reply | system="${promptHead}" | input="${inputHead}"`;
}

class MockLlmClient implements LlmClient {
  async complete(systemPrompt: string, userInput: string, signal?: AbortSignal): Promise<string> {
    await sleepRespectingSignal(delayMs(), signal);
    maybeThrowBilling();
    return syntheticReply(systemPrompt, userInput);
  }

  async completeWithTools(
    systemPrompt: string,
    messages: unknown[],
    _tools: ToolDef[],
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    await sleepRespectingSignal(delayMs(), signal);
    maybeThrowBilling();
    const lastMessage = messages.at(-1);
    const inputText =
      typeof lastMessage === 'string'
        ? lastMessage
        : JSON.stringify(lastMessage ?? '').slice(0, 200);
    return { type: 'text', text: syntheticReply(systemPrompt, inputText) };
  }

  formatToolResultMessages(_results: ToolResult[]): unknown[] {
    return [];
  }
}

function sleepRespectingSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isMockLlmEnabled(): boolean {
  return process.env.MOCK_LLM === '1' || process.env.MOCK_LLM?.toLowerCase() === 'true';
}

/**
 * Throw if MOCK_LLM is enabled in a production deployment. Called from
 * `cmdStart` before any state is mutated so a misconfig fails fast and
 * loud instead of silently serving fake answers in front of paying users.
 */
export function refuseMockLlmInProduction(): void {
  if (isMockLlmEnabled() && process.env.NODE_ENV === 'production') {
    throw new Error('MOCK_LLM=1 is not allowed in NODE_ENV=production. Unset one or the other.');
  }
}

export function createMockLlmClient(): LlmClient {
  return new MockLlmClient();
}
