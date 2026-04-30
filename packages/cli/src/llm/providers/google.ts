/**
 * Google (Gemini) provider descriptor.
 *
 * Uses Google's OpenAI-compatible endpoint at
 * `https://generativelanguage.googleapis.com/v1beta/openai`. The
 * `/models` route returns ids prefixed with `models/`; the model id
 * mapper strips that prefix and drops non-Gemini entries (embeddings,
 * legacy PaLM, etc.) so the picker only shows usable chat models.
 */

import type { LlmProviderDescriptor } from '../registry';
import { createOpenAICompatibleProvider } from './openai-compatible';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];
const MODELS_PREFIX = 'models/';

function mapGeminiModelId(id: string): string | null {
  const stripped = id.startsWith(MODELS_PREFIX) ? id.slice(MODELS_PREFIX.length) : id;
  return stripped.startsWith('gemini') ? stripped : null;
}

export const GOOGLE_PROVIDER: LlmProviderDescriptor = createOpenAICompatibleProvider({
  id: 'google',
  displayName: 'Google (Gemini)',
  envVar: 'GEMINI_API_KEY',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  defaultModel: DEFAULT_MODEL,
  fallbackModels: FALLBACK_MODELS,
  mapModelId: mapGeminiModelId,
});
