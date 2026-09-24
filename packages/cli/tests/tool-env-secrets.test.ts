/**
 * An LLM-mode skill's tool subprocess inherits the operator's environment minus
 * the secrets the SDK strips (`scopedToolEnv`). That list is written by hand in
 * the SDK, and the providers live here: a provider added without its key in the
 * list would hand that key to every tool script. This ties the two together.
 */
import { afterEach, describe, expect, it } from 'vitest';
// Not part of the SDK's public API, so read from its source; the CLI already
// depends on the SDK, so the test adds no new direction.
import { scopedToolEnv } from '../../sdk/src/skills/scriptSkill';
import { listLlmProviders } from '../src/llm/registry';

const PLANTED = 'planted-secret-value';

describe('tool subprocess environment', () => {
  const planted: string[] = [];

  afterEach(() => {
    for (const name of planted.splice(0)) {
      delete process.env[name];
    }
  });

  it('strips the API key of every registered LLM provider', () => {
    const providers = listLlmProviders();
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      process.env[provider.envVar] = PLANTED;
      planted.push(provider.envVar);
    }
    const env = scopedToolEnv();
    const leaked = providers
      .map((provider) => provider.envVar)
      .filter((name) => env[name] !== undefined);
    expect(leaked).toEqual([]);
  });

  it('keeps an unrelated variable, so the check is not vacuous', () => {
    process.env.ELISYM_TOOL_ENV_PROBE = PLANTED;
    planted.push('ELISYM_TOOL_ENV_PROBE');
    expect(scopedToolEnv().ELISYM_TOOL_ENV_PROBE).toBe(PLANTED);
  });
});
