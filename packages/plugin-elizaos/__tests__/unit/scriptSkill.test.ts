import { describe, expect, it } from 'vitest';
import { ScriptSkill } from '../../src/skills/scriptSkill';
import type { LlmClient, ToolDef, ToolResult, CompletionResult } from '../../src/skills/types';

function makeLlm(sequence: CompletionResult[]): LlmClient {
  let index = 0;
  return {
    async complete() {
      throw new Error('not used in these tests');
    },
    async completeWithTools(): Promise<CompletionResult> {
      const result = sequence[index];
      index++;
      if (!result) {
        throw new Error('LLM mock exhausted');
      }
      return result;
    },
    formatToolResultMessages(results: ToolResult[]): unknown[] {
      return [{ role: 'user', content: results }];
    },
  };
}

describe('ScriptSkill', () => {
  it('returns text when LLM answers without tool calls', async () => {
    const skill = new ScriptSkill({
      name: 'noop',
      description: 'does nothing',
      capabilities: ['noop'],
      priceLamports: 1000n,
      skillDir: '/tmp',
      systemPrompt: 'be terse',
      tools: [
        {
          name: 'echo',
          description: 'echo',
          command: ['echo'],
          parameters: [{ name: 'text', description: 'text', required: true }],
        },
      ],
      maxToolRounds: 3,
    });

    const llm = makeLlm([{ type: 'text', text: 'hello world' }]);
    const result = await skill.execute(
      { data: 'hi', inputType: 'text/plain', tags: [], jobId: 'j1' },
      { llm, agentName: 'test', agentDescription: 'test' },
    );
    expect(result.data).toBe('hello world');
  });

  it('runs the declared tool with positional-first-required arg', async () => {
    const skill = new ScriptSkill({
      name: 'echoer',
      description: 'echo',
      capabilities: ['echo'],
      priceLamports: 1000n,
      skillDir: '/tmp',
      systemPrompt: 'echo',
      tools: [
        {
          name: 'echo',
          description: 'echo',
          command: ['echo'],
          parameters: [{ name: 'text', description: 'text', required: true }],
        },
      ],
      maxToolRounds: 3,
    });

    const llm = makeLlm([
      {
        type: 'tool_use',
        calls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi-from-skill' } }],
        assistantMessage: { role: 'assistant', content: [] },
      },
      { type: 'text', text: 'all done' },
    ]);

    const result = await skill.execute(
      { data: 'run', inputType: 'text/plain', tags: [], jobId: 'j2' },
      { llm, agentName: 'test', agentDescription: 'test' },
    );
    expect(result.data).toBe('all done');
  });

  it('returns an error string when the tool exits non-zero instead of throwing', async () => {
    const skill = new ScriptSkill({
      name: 'fail',
      description: 'fail',
      capabilities: ['fail'],
      priceLamports: 1000n,
      skillDir: '/tmp',
      systemPrompt: '',
      tools: [
        {
          name: 'exit1',
          description: 'exits 1',
          command: ['sh', '-c', 'exit 1'],
        },
      ],
      maxToolRounds: 2,
    });

    let observedContent = '';
    const llm: LlmClient = {
      async complete() {
        return '';
      },
      async completeWithTools() {
        return {
          type: 'tool_use',
          calls: [{ id: 't1', name: 'exit1', arguments: {} }],
          assistantMessage: { role: 'assistant', content: [] },
        };
      },
      formatToolResultMessages(results: ToolResult[]): unknown[] {
        observedContent = results[0]?.content ?? '';
        // Terminate the loop by throwing on second LLM round.
        throw new Error('end of test');
      },
    };

    await expect(
      skill.execute(
        { data: 'run', inputType: 'text/plain', tags: [], jobId: 'j3' },
        { llm, agentName: 'test', agentDescription: 'test' },
      ),
    ).rejects.toThrow();
    expect(observedContent).toMatch(/Error \(exit 1\)/);
  });

  it('throws when max_tool_rounds is exceeded', async () => {
    const skill = new ScriptSkill({
      name: 'looper',
      description: 'loops forever',
      capabilities: ['loop'],
      priceLamports: 1000n,
      skillDir: '/tmp',
      systemPrompt: '',
      tools: [
        {
          name: 'no',
          description: 'x',
          command: ['true'],
        },
      ],
      maxToolRounds: 2,
    });

    const alwaysCalls: CompletionResult = {
      type: 'tool_use',
      calls: [{ id: 'z', name: 'no', arguments: {} }],
      assistantMessage: { role: 'assistant', content: [] },
    };
    const llm = makeLlm([alwaysCalls, alwaysCalls, alwaysCalls]);
    await expect(
      skill.execute(
        { data: 'run', inputType: 'text/plain', tags: [], jobId: 'j4' },
        { llm, agentName: 'test', agentDescription: 'test' },
      ),
    ).rejects.toThrow(/Max tool rounds \(2\) exceeded/);
  });

  it('throws when ctx.llm is missing', async () => {
    const skill = new ScriptSkill({
      name: 'x',
      description: 'x',
      capabilities: ['x'],
      priceLamports: 1000n,
      skillDir: '/tmp',
      systemPrompt: '',
      tools: [],
      maxToolRounds: 1,
    });
    await expect(
      skill.execute({ data: '', inputType: 'text/plain', tags: [], jobId: 'j5' }, {
        agentName: 'x',
        agentDescription: 'x',
      } as unknown as Parameters<ScriptSkill['execute']>[1]),
    ).rejects.toThrow(/LLM client not configured/);
  });
});

describe('ScriptSkill tool definitions passed to the LLM', () => {
  it('projects parameters and required flags to ToolDef', async () => {
    const skill = new ScriptSkill({
      name: 'projector',
      description: 'x',
      capabilities: ['x'],
      priceLamports: 1000n,
      skillDir: '/tmp',
      systemPrompt: '',
      tools: [
        {
          name: 't',
          description: 'd',
          command: ['true'],
          parameters: [
            { name: 'a', description: 'A', required: true },
            { name: 'b', description: 'B', required: false },
            { name: 'c', description: 'C' },
          ],
        },
      ],
      maxToolRounds: 1,
    });
    let seen: ToolDef[] = [];
    const llm: LlmClient = {
      async complete() {
        return '';
      },
      async completeWithTools(_system, _messages, tools): Promise<CompletionResult> {
        seen = tools;
        return { type: 'text', text: 'done' };
      },
      formatToolResultMessages() {
        return [];
      },
    };
    await skill.execute(
      { data: '', inputType: 'text/plain', tags: [], jobId: 'j' },
      { llm, agentName: 'x', agentDescription: 'x' },
    );
    expect(seen).toEqual([
      {
        name: 't',
        description: 'd',
        parameters: [
          { name: 'a', description: 'A', required: true },
          { name: 'b', description: 'B', required: false },
          { name: 'c', description: 'C', required: true },
        ],
      },
    ]);
  });
});
