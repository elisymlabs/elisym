import type { LlmClient } from '@elisym/sdk/skills';
import { describe, expect, it } from 'vitest';
import {
  createLlmClient,
  getLlmProvider,
  getRegisteredProviderIds,
  listLlmProviders,
  registerLlmProvider,
  type LlmProviderDescriptor,
} from '../src/llm';

describe('LLM provider registry', () => {
  describe('builtins', () => {
    it('registers anthropic, openai, xai, google, and deepseek by default', () => {
      const ids = getRegisteredProviderIds();
      expect(ids).toContain('anthropic');
      expect(ids).toContain('openai');
      expect(ids).toContain('xai');
      expect(ids).toContain('google');
      expect(ids).toContain('deepseek');
    });

    describe.each([
      {
        id: 'xai',
        envVar: 'XAI_API_KEY',
        displayName: 'xAI (Grok)',
        defaultModelPrefix: 'grok-',
      },
      {
        id: 'google',
        envVar: 'GEMINI_API_KEY',
        displayName: 'Google (Gemini)',
        defaultModelPrefix: 'gemini-',
      },
      {
        id: 'deepseek',
        envVar: 'DEEPSEEK_API_KEY',
        displayName: 'DeepSeek',
        defaultModelPrefix: 'deepseek-',
      },
    ])('OpenAI-compatible descriptor: $id', ({ id, envVar, displayName, defaultModelPrefix }) => {
      it('exposes the expected fields', () => {
        const descriptor = getLlmProvider(id);
        expect(descriptor).toBeDefined();
        expect(descriptor?.envVar).toBe(envVar);
        expect(descriptor?.displayName).toBe(displayName);
        expect(descriptor?.defaultModel.startsWith(defaultModelPrefix)).toBe(true);
        expect(descriptor?.fallbackModels.length).toBeGreaterThan(0);
      });

      it('createLlmClient returns a usable client', () => {
        const client = createLlmClient({
          provider: id,
          apiKey: 'sk-test',
          model: `${defaultModelPrefix}placeholder`,
          maxTokens: 1,
        });
        expect(typeof client.complete).toBe('function');
        expect(typeof client.completeWithTools).toBe('function');
        expect(typeof client.formatToolResultMessages).toBe('function');
      });
    });

    it('exposes Anthropic descriptor with the required fields', () => {
      const descriptor = getLlmProvider('anthropic');
      expect(descriptor).toBeDefined();
      expect(descriptor?.envVar).toBe('ANTHROPIC_API_KEY');
      expect(descriptor?.displayName).toBe('Anthropic (Claude)');
      expect(descriptor?.defaultModel).toMatch(/^claude-/);
      expect(descriptor?.fallbackModels.length).toBeGreaterThan(0);
    });

    it('exposes OpenAI descriptor with reasoning-model detection', () => {
      const descriptor = getLlmProvider('openai');
      expect(descriptor).toBeDefined();
      expect(descriptor?.envVar).toBe('OPENAI_API_KEY');
      expect(descriptor?.isReasoningModel?.('o3-mini')).toBe(true);
      expect(descriptor?.isReasoningModel?.('gpt-5-mini')).toBe(true);
      expect(descriptor?.isReasoningModel?.('gpt-4o')).toBe(false);
    });

    it('listLlmProviders returns descriptors for every registered id', () => {
      const ids = getRegisteredProviderIds();
      const list = listLlmProviders();
      expect(list.length).toBe(ids.length);
      for (const descriptor of list) {
        expect(ids).toContain(descriptor.id);
      }
    });
  });

  describe('createLlmClient delegation', () => {
    it('returns an Anthropic client for provider:anthropic', () => {
      const client = createLlmClient({
        provider: 'anthropic',
        apiKey: 'sk-test',
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1024,
      });
      expect(typeof client.complete).toBe('function');
      expect(typeof client.completeWithTools).toBe('function');
      expect(typeof client.formatToolResultMessages).toBe('function');
    });

    it('returns an OpenAI client for provider:openai', () => {
      const client = createLlmClient({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        maxTokens: 1024,
      });
      expect(typeof client.complete).toBe('function');
      expect(typeof client.completeWithTools).toBe('function');
      expect(typeof client.formatToolResultMessages).toBe('function');
    });

    it('throws on unknown provider id', () => {
      expect(() =>
        createLlmClient({ provider: 'bogus-llm', apiKey: 'sk', model: 'x', maxTokens: 1 }),
      ).toThrow(/Unknown LLM provider/);
    });

    it('throws on empty apiKey with the provider env var name in the message', () => {
      expect(() =>
        createLlmClient({ provider: 'anthropic', apiKey: '', model: 'm', maxTokens: 1 }),
      ).toThrow(/ANTHROPIC_API_KEY/);
      expect(() =>
        createLlmClient({ provider: 'openai', apiKey: '', model: 'm', maxTokens: 1 }),
      ).toThrow(/OPENAI_API_KEY/);
    });
  });

  describe('registerLlmProvider', () => {
    it('accepts and looks up a custom descriptor', () => {
      const fake: LlmProviderDescriptor = {
        id: 'fake-test-provider',
        displayName: 'Fake (test)',
        envVar: 'FAKE_API_KEY',
        defaultModel: 'fake-1',
        fallbackModels: ['fake-1'],
        async fetchModels() {
          return ['fake-1'];
        },
        async verifyKey() {
          return { ok: true };
        },
        createClient(): LlmClient {
          return {
            async complete() {
              return 'fake';
            },
            async completeWithTools() {
              return { type: 'text', text: 'fake' };
            },
            formatToolResultMessages() {
              return [];
            },
          };
        },
      };
      registerLlmProvider(fake);
      expect(getLlmProvider('fake-test-provider')).toBe(fake);
      const client = createLlmClient({
        provider: 'fake-test-provider',
        apiKey: 'k',
        model: 'fake-1',
        maxTokens: 1,
      });
      expect(client).toBeDefined();
    });

    it('overwrites a prior descriptor with the same id', () => {
      const first: LlmProviderDescriptor = {
        id: 'overwrite-test',
        displayName: 'first',
        envVar: 'X',
        defaultModel: 'm',
        fallbackModels: ['m'],
        async fetchModels() {
          return ['m'];
        },
        async verifyKey() {
          return { ok: true };
        },
        createClient() {
          return {} as LlmClient;
        },
      };
      const second: LlmProviderDescriptor = { ...first, displayName: 'second' };
      registerLlmProvider(first);
      registerLlmProvider(second);
      expect(getLlmProvider('overwrite-test')?.displayName).toBe('second');
    });
  });
});
