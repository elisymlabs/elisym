import { describe, expect, it, vi } from 'vitest';
import { NATIVE_SOL } from '../src/payment/assets';
import { ScriptSkill } from '../src/skills/scriptSkill';
import type { ChatTurn, CompletionResult, LlmClient, ToolResult } from '../src/skills/types';

const HISTORY: ChatTurn[] = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
];

function makeLlm(withToolsResult: CompletionResult): LlmClient {
  return {
    complete: vi.fn().mockResolvedValue('done'),
    completeWithTools: vi.fn().mockResolvedValue(withToolsResult),
    formatToolResultMessages: vi.fn((results: ToolResult[]) =>
      results.map((result) => ({ role: 'tool', content: result.content })),
    ),
  };
}

function makeSkill(tools: Array<{ name: string; description: string }> = []) {
  return new ScriptSkill({
    name: 'chatty',
    description: 'chatty',
    capabilities: ['chat'],
    priceSubunits: 0n,
    asset: NATIVE_SOL,
    skillDir: '/tmp',
    systemPrompt: 'You are helpful.',
    tools: tools.map((tool) => ({ ...tool, command: 'true', parameters: [] })),
    maxToolRounds: 3,
    context: true,
  });
}

describe('ScriptSkill - session history', () => {
  it('passes history through to llm.complete on the no-tools path', async () => {
    const llm = makeLlm({ type: 'text', text: '' });
    const skill = makeSkill();
    await skill.execute(
      { data: 'second question', inputType: 'text', tags: ['chat'], jobId: 'j1', history: HISTORY },
      { llm, agentName: 'a', agentDescription: '' },
    );
    expect(llm.complete).toHaveBeenCalledWith(
      'You are helpful.',
      'second question',
      undefined,
      HISTORY,
    );
  });

  it('omits history (undefined) when the input carries none', async () => {
    const llm = makeLlm({ type: 'text', text: '' });
    const skill = makeSkill();
    await skill.execute(
      { data: 'one shot', inputType: 'text', tags: ['chat'], jobId: 'j2' },
      { llm, agentName: 'a', agentDescription: '' },
    );
    expect(llm.complete).toHaveBeenCalledWith('You are helpful.', 'one shot', undefined, undefined);
  });

  it('prepends history to the tools-path messages array', async () => {
    const llm = makeLlm({ type: 'text', text: 'tool answer' });
    const skill = makeSkill([{ name: 'lookup', description: 'looks up' }]);
    await skill.execute(
      { data: 'second question', inputType: 'text', tags: ['chat'], jobId: 'j3', history: HISTORY },
      { llm, agentName: 'a', agentDescription: '' },
    );
    const messages = (llm.completeWithTools as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(messages).toEqual([...HISTORY, { role: 'user', content: 'second question' }]);
  });

  it('exposes the context flag on the skill instance', () => {
    expect(makeSkill().context).toBe(true);
  });
});
