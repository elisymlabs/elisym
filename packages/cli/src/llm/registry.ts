/**
 * Pluggable LLM provider registry.
 *
 * Each provider (Anthropic, OpenAI, future Grok/Gemini/...) lives as a
 * `LlmProviderDescriptor` in its own file under `./providers/`. The CLI
 * looks up env-var name, default model, model list, key verification,
 * and client construction through this registry, so adding a provider
 * is one descriptor file plus one registration call below.
 *
 * Builtins are imported statically and registered at module init. The
 * descriptor files reach back to this module only via `import type`, so
 * there is no runtime cycle - registry evaluation completes before any
 * descriptor's runtime body runs.
 */

import type { LlmKeyVerification } from '@elisym/sdk/llm-health';
import type { LlmClient } from '@elisym/sdk/skills';
import { ANTHROPIC_PROVIDER } from './providers/anthropic';
import { DEEPSEEK_PROVIDER } from './providers/deepseek';
import { GOOGLE_PROVIDER } from './providers/google';
import { OPENAI_PROVIDER } from './providers/openai';
import { XAI_PROVIDER } from './providers/xai';

export type { LlmKeyVerification } from '@elisym/sdk/llm-health';

/**
 * Config passed to a descriptor's `createClient`. Mirrors the SDK's
 * `LlmClientConfig` minus `provider` (already implied by the descriptor)
 * plus an optional `logUsage` flag the client uses to print token
 * counts to stdout. CLI-internal type so SDK clients (none any more)
 * stay log-free.
 */
export interface CreateLlmClientConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  /** Print `[LLM] <model> tokens: in=N out=M (total: in=… out=…)` after each call. */
  logUsage?: boolean;
}

/**
 * Token usage extracted from a provider's raw response. Reserved for
 * future telemetry hooks; concrete clients log their own usage today.
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProviderDescriptor {
  /** Stable identifier used in elisym.yaml `llm.provider` and SKILL.md `provider:`. */
  id: string;
  /** Human-readable label for interactive prompts. */
  displayName: string;
  /** Operator-facing env var that supplies the API key when no per-agent secret is set. */
  envVar: string;
  /** Default model when neither agent nor skill picks one. */
  defaultModel: string;
  /** Hard-coded fallback list when `fetchModels` cannot reach the provider. */
  fallbackModels: string[];
  /** Pull the live model list from the provider. Returns `fallbackModels` on failure. */
  fetchModels(apiKey: string, signal?: AbortSignal): Promise<string[]>;
  /**
   * Lightweight authenticated probe before the agent publishes capabilities.
   * Hits a metadata endpoint (e.g. `/v1/models`) so it does not consume
   * billing credits. Used for UI commands and as a cheap liveness check.
   */
  verifyKey(apiKey: string, signal?: AbortSignal): Promise<LlmKeyVerification>;
  /**
   * Authoritative deep probe that consumes a single token from the
   * provider's billing account. Distinguishes invalid keys, billing/quota
   * exhaustion, and transient unavailability. Used at agent startup,
   * runtime preflight, and the LLM health heartbeat.
   *
   * Caller passes the model the skill will actually use - billing checks
   * are scoped to that model since some orgs gate access per model.
   */
  verifyKeyDeep(apiKey: string, model: string, signal?: AbortSignal): Promise<LlmKeyVerification>;
  /** Build a fresh `LlmClient` for the given config (apiKey + model + maxTokens + logUsage). */
  createClient(config: CreateLlmClientConfig): LlmClient;
  /** True when the model uses provider-specific reasoning quirks (e.g. OpenAI o1/o3/gpt-5 family). */
  isReasoningModel?(model: string): boolean;
}

const REGISTRY = new Map<string, LlmProviderDescriptor>();

/**
 * Register or replace a provider descriptor. Calling twice with the same
 * `id` overwrites the prior entry - useful for tests.
 */
export function registerLlmProvider(descriptor: LlmProviderDescriptor): void {
  REGISTRY.set(descriptor.id, descriptor);
}

/** Look up a provider by id. Returns undefined when not registered. */
export function getLlmProvider(id: string): LlmProviderDescriptor | undefined {
  return REGISTRY.get(id);
}

/** Snapshot of all registered descriptors. Order: registration order. */
export function listLlmProviders(): LlmProviderDescriptor[] {
  return Array.from(REGISTRY.values());
}

/** Snapshot of all registered ids. */
export function getRegisteredProviderIds(): string[] {
  return Array.from(REGISTRY.keys());
}

// Builtin registration. Order here is the registration order seen by
// `listLlmProviders` and the order interactive prompts will offer.
registerLlmProvider(ANTHROPIC_PROVIDER);
registerLlmProvider(OPENAI_PROVIDER);
registerLlmProvider(XAI_PROVIDER);
registerLlmProvider(GOOGLE_PROVIDER);
registerLlmProvider(DEEPSEEK_PROVIDER);
