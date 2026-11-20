import type { LlmProvider, TurnRequest, TurnResponse } from './types';

/** Told when a model failed and the next one in the cascade is tried; no content (4.4). */
export type FallbackListener = (failed: string, next: string, error: unknown) => void;

/**
 * Models in order of preference, behind one provider: every call goes to the first, and only
 * when it throws (a provider error, a timeout, no route) to the next, and so on; the last one's
 * error ends the call. A response the model gave, a refusal or a cut-off answer included, is
 * never retried elsewhere: the turn decides what it means. An aborted request is not retried.
 * The response names the model that gave it, so its cost is priced at that model's price.
 */
export function createCascadeProvider(
  providers: readonly LlmProvider[],
  onFallback?: FallbackListener,
): LlmProvider {
  const [first] = providers;
  if (first === undefined) {
    throw new Error('A model cascade needs at least one model');
  }
  return {
    model: first.model,
    async turn(request: TurnRequest): Promise<TurnResponse> {
      let lastError: unknown;
      for (const [index, provider] of providers.entries()) {
        try {
          const response = await provider.turn(request);
          return { ...response, model: provider.model };
        } catch (error) {
          lastError = error;
          const next = providers[index + 1];
          if (request.signal?.aborted || next === undefined) {
            throw error;
          }
          onFallback?.(provider.model, next.model, error);
        }
      }
      throw lastError;
    },
  };
}
