/**
 * DeepSeek provider descriptor.
 *
 * DeepSeek's API is OpenAI-compatible at `https://api.deepseek.com/v1`,
 * so this is a thin wrapper around `createOpenAICompatibleProvider`.
 */

import type { LlmProviderDescriptor } from '../registry';
import { createOpenAICompatibleProvider } from './openai-compatible';

const DEFAULT_MODEL = 'deepseek-chat';
const FALLBACK_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

export const DEEPSEEK_PROVIDER: LlmProviderDescriptor = createOpenAICompatibleProvider({
  id: 'deepseek',
  displayName: 'DeepSeek',
  envVar: 'DEEPSEEK_API_KEY',
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: DEFAULT_MODEL,
  fallbackModels: FALLBACK_MODELS,
});
