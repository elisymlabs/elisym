import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_SOL } from '../src/payment/assets';
import { ScriptSkill } from '../src/skills/scriptSkill';
import type {
  CompletionResult,
  LlmClient,
  SkillContext,
  SkillLlmOverride,
} from '../src/skills/types';

function makeClient(label: string): LlmClient {
  return {
    complete: vi.fn(async () => `${label}-result`),
    completeWithTools: vi.fn(
      async (): Promise<CompletionResult> => ({ type: 'text', text: `${label}-tools-result` }),
    ),
    formatToolResultMessages: vi.fn(() => []),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'scriptSkill-llm-override-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function buildSkill(llmOverride?: SkillLlmOverride): ScriptSkill {
  return new ScriptSkill({
    name: 'demo',
    description: 'd',
    capabilities: ['text'],
    priceSubunits: 0n,
    asset: NATIVE_SOL,
    skillDir: tmpDir,
    systemPrompt: 'You are helpful.',
    tools: [],
    maxToolRounds: 5,
    llmOverride,
  });
}

describe('ScriptSkill llm resolution contract', () => {
  it('throws when llmOverride is set but ctx.getLlm is missing', async () => {
    const skill = buildSkill({ provider: 'openai', model: 'gpt-5-mini' });
    const ctxLlm = makeClient('agent-default');
    const ctx: SkillContext = {
      llm: ctxLlm,
      agentName: 'a',
      agentDescription: '',
    };
    await expect(
      skill.execute({ data: 'hi', inputType: 'text', tags: ['text'], jobId: 'j1' }, ctx),
    ).rejects.toThrow(/requires ctx.getLlm to be configured/);
    expect(ctxLlm.complete).not.toHaveBeenCalled();
  });

  it('uses ctx.getLlm(override) when llmOverride is set', async () => {
    const skill = buildSkill({ provider: 'openai', model: 'gpt-5-mini' });
    const overrideClient = makeClient('override');
    const getLlm = vi.fn(() => overrideClient);
    const ctx: SkillContext = {
      getLlm,
      agentName: 'a',
      agentDescription: '',
    };
    const result = await skill.execute(
      { data: 'hi', inputType: 'text', tags: ['text'], jobId: 'j1' },
      ctx,
    );
    expect(result.data).toBe('override-result');
    expect(getLlm).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5-mini' });
  });

  it('falls back to ctx.llm when no override and no getLlm', async () => {
    const skill = buildSkill();
    const ctxLlm = makeClient('agent-default');
    const ctx: SkillContext = {
      llm: ctxLlm,
      agentName: 'a',
      agentDescription: '',
    };
    const result = await skill.execute(
      { data: 'hi', inputType: 'text', tags: ['text'], jobId: 'j1' },
      ctx,
    );
    expect(result.data).toBe('agent-default-result');
    expect(ctxLlm.complete).toHaveBeenCalled();
  });

  it('prefers ctx.getLlm() over ctx.llm when no override', async () => {
    const skill = buildSkill();
    const fromGetLlm = makeClient('from-get-llm');
    const fromCtxLlm = makeClient('from-ctx-llm');
    const ctx: SkillContext = {
      llm: fromCtxLlm,
      getLlm: () => fromGetLlm,
      agentName: 'a',
      agentDescription: '',
    };
    const result = await skill.execute(
      { data: 'hi', inputType: 'text', tags: ['text'], jobId: 'j1' },
      ctx,
    );
    expect(result.data).toBe('from-get-llm-result');
    expect(fromCtxLlm.complete).not.toHaveBeenCalled();
  });

  it('throws when neither override nor any client is wired', async () => {
    const skill = buildSkill();
    const ctx: SkillContext = {
      agentName: 'a',
      agentDescription: '',
    };
    await expect(
      skill.execute({ data: 'hi', inputType: 'text', tags: ['text'], jobId: 'j1' }, ctx),
    ).rejects.toThrow('LLM client not configured for skill runtime');
  });
});
