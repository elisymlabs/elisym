/**
 * xAI (Grok) provider descriptor.
 *
 * xAI exposes an OpenAI-compatible Chat Completions endpoint at
 * `https://api.x.ai/v1`, so this is a thin wrapper around
 * `createOpenAICompatibleProvider`.
 */

import type { LlmProviderDescriptor } from '../registry';
import { createOpenAICompatibleProvider } from './openai-compatible';

const DEFAULT_MODEL = 'grok-3-mini';
const FALLBACK_MODELS = ['grok-4', 'grok-3', 'grok-3-mini'];

export const XAI_PROVIDER: LlmProviderDescriptor = createOpenAICompatibleProvider({
  id: 'xai',
  displayName: 'xAI (Grok)',
  envVar: 'XAI_API_KEY',
  baseUrl: 'https://api.x.ai/v1',
  defaultModel: DEFAULT_MODEL,
  fallbackModels: FALLBACK_MODELS,
});
