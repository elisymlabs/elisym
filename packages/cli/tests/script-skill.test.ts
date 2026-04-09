import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { LlmClient, CompletionResult, ToolResult } from '../src/skill/index.js';
import { ScriptSkill } from '../src/skill/script-skill.js';

function makeMockLlm(responses: CompletionResult[]): LlmClient {
  let callIndex = 0;
  return {
    complete: vi.fn().mockImplementation(async () => 'simple result'),
    completeWithTools: vi.fn().mockImplementation(async () => {
      const resp = responses[callIndex];
      if (!resp) {
        throw new Error(`No mock response for call index ${callIndex}`);
      }
      callIndex++;
      return resp;
    }),
    formatToolResultMessages: vi.fn().mockImplementation((results: ToolResult[]) =>
      results.map((r) => ({
        role: 'tool',
        tool_call_id: r.callId,
        content: r.content,
      })),
    ),
  };
}

describe('ScriptSkill', () => {
  describe('execute without tools', () => {
    it('calls llm.complete for no-tool skill', async () => {
      const skill = new ScriptSkill(
        'simple',
        'A simple skill',
        ['text-gen'],
        0,
        undefined,
        undefined,
        '/tmp',
        'You are helpful.',
        [],
        10,
      );

      const llm = makeMockLlm([]);
      const result = await skill.execute(
        { data: 'hello', inputType: 'text', tags: ['text-gen'], jobId: 'j1' },
        { llm, agentName: 'test', agentDescription: '' },
      );

      expect(result.data).toBe('simple result');
      expect(llm.complete).toHaveBeenCalledWith('You are helpful.', 'hello', undefined);
    });

    it('throws when LLM not configured', async () => {
      const skill = new ScriptSkill(
        'simple',
        'desc',
        ['a'],
        0,
        undefined,
        undefined,
        '/tmp',
        'prompt',
        [],
        10,
      );

      await expect(
        skill.execute(
          { data: 'hello', inputType: 'text', tags: ['a'], jobId: 'j1' },
          { agentName: 'test', agentDescription: '' },
        ),
      ).rejects.toThrow('LLM client not configured');
    });
  });

  describe('execute with tools (tool-use loop)', () => {
    it('handles single tool call round then text response', async () => {
      const llm = makeMockLlm([
        {
          type: 'tool_use',
          calls: [{ id: 'call_1', name: 'echo_tool', arguments: { message: 'hi' } }],
          assistantMessage: { role: 'assistant', content: 'calling tool' },
        },
        { type: 'text', text: 'Final answer based on tool output' },
      ]);

      // Create a real script that echoes its argument
      const tmp = mkdtempSync(join(tmpdir(), 'skill-exec-'));
      const scriptPath = join(tmp, 'echo.sh');
      writeFileSync(scriptPath, '#!/bin/sh\necho "$1"');
      chmodSync(scriptPath, 0o755);

      try {
        const skill = new ScriptSkill(
          'echo-skill',
          'Echo skill',
          ['echo'],
          0,
          undefined,
          undefined,
          tmp,
          'You are an echo bot.',
          [
            {
              name: 'echo_tool',
              description: 'Echo a message',
              command: [scriptPath],
              parameters: [{ name: 'message', description: 'Message to echo', required: true }],
            },
          ],
          10,
        );

        const result = await skill.execute(
          { data: 'echo hi', inputType: 'text', tags: ['echo'], jobId: 'j2' },
          { llm, agentName: 'test', agentDescription: '' },
        );

        expect(result.data).toBe('Final answer based on tool output');
        expect(llm.completeWithTools).toHaveBeenCalledTimes(2);
        expect(llm.formatToolResultMessages).toHaveBeenCalledOnce();

        // Verify tool result was passed
        const toolResults = (llm.formatToolResultMessages as any).mock.calls[0][0];
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].callId).toBe('call_1');
        expect(toolResults[0].content).toBe('hi');
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('handles multiple tool calls in one round', async () => {
      const llm = makeMockLlm([
        {
          type: 'tool_use',
          calls: [
            { id: 'c1', name: 'echo_tool', arguments: { message: 'a' } },
            { id: 'c2', name: 'echo_tool', arguments: { message: 'b' } },
          ],
          assistantMessage: { role: 'assistant', content: 'calling tools' },
        },
        { type: 'text', text: 'Got both results' },
      ]);

      const tmp = mkdtempSync(join(tmpdir(), 'skill-exec-'));
      const scriptPath = join(tmp, 'echo.sh');
      writeFileSync(scriptPath, '#!/bin/sh\necho "$1"');
      chmodSync(scriptPath, 0o755);

      try {
        const skill = new ScriptSkill(
          'multi',
          'Multi tool',
          ['multi'],
          0,
          undefined,
          undefined,
          tmp,
          'prompt',
          [
            {
              name: 'echo_tool',
              description: 'Echo',
              command: [scriptPath],
              parameters: [{ name: 'message', description: 'Msg', required: true }],
            },
          ],
          10,
        );

        const result = await skill.execute(
          { data: 'do both', inputType: 'text', tags: ['multi'], jobId: 'j3' },
          { llm, agentName: 'test', agentDescription: '' },
        );

        expect(result.data).toBe('Got both results');
        const toolResults = (llm.formatToolResultMessages as any).mock.calls[0][0];
        expect(toolResults).toHaveLength(2);
        expect(toolResults[0].content).toBe('a');
        expect(toolResults[1].content).toBe('b');
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('returns error for unknown tool name', async () => {
      const llm = makeMockLlm([
        {
          type: 'tool_use',
          calls: [{ id: 'c1', name: 'nonexistent', arguments: {} }],
          assistantMessage: { role: 'assistant', content: 'calling tool' },
        },
        { type: 'text', text: 'ok' },
      ]);

      const skill = new ScriptSkill(
        'test',
        'desc',
        ['a'],
        0,
        undefined,
        undefined,
        '/tmp',
        'prompt',
        [{ name: 'real_tool', description: 'Real', command: ['echo'] }],
        10,
      );

      const result = await skill.execute(
        { data: 'test', inputType: 'text', tags: ['a'], jobId: 'j4' },
        { llm, agentName: 'test', agentDescription: '' },
      );

      expect(result.data).toBe('ok');
      const toolResults = (llm.formatToolResultMessages as any).mock.calls[0][0];
      expect(toolResults[0].content).toContain('Error: unknown tool');
    });

    it('throws on max tool rounds exceeded', async () => {
      // All responses are tool_use - never returns text
      const responses: CompletionResult[] = Array.from({ length: 3 }, (_, i) => ({
        type: 'tool_use' as const,
        calls: [{ id: `c${i}`, name: 'echo_tool', arguments: { message: 'loop' } }],
        assistantMessage: { role: 'assistant', content: 'calling' },
      }));
      const llm = makeMockLlm(responses);

      const tmp = mkdtempSync(join(tmpdir(), 'skill-exec-'));
      const scriptPath = join(tmp, 'echo.sh');
      writeFileSync(scriptPath, '#!/bin/sh\necho "$1"');
      chmodSync(scriptPath, 0o755);

      try {
        const skill = new ScriptSkill(
          'loop',
          'desc',
          ['a'],
          0,
          undefined,
          undefined,
          tmp,
          'prompt',
          [
            {
              name: 'echo_tool',
              description: 'Echo',
              command: [scriptPath],
              parameters: [{ name: 'message', description: 'Msg', required: true }],
            },
          ],
          2, // max 2 rounds
        );

        await expect(
          skill.execute(
            { data: 'test', inputType: 'text', tags: ['a'], jobId: 'j5' },
            { llm, agentName: 'test', agentDescription: '' },
          ),
        ).rejects.toThrow('Max tool rounds (2) exceeded');
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('aborts on signal before tool round', async () => {
      const llm = makeMockLlm([
        {
          type: 'tool_use',
          calls: [{ id: 'c1', name: 'echo_tool', arguments: { message: 'hi' } }],
          assistantMessage: { role: 'assistant', content: 'calling' },
        },
      ]);

      const skill = new ScriptSkill(
        'abort',
        'desc',
        ['a'],
        0,
        undefined,
        undefined,
        '/tmp',
        'prompt',
        [{ name: 'echo_tool', description: 'Echo', command: ['echo'] }],
        10,
      );

      const controller = new AbortController();
      controller.abort();

      await expect(
        skill.execute(
          { data: 'test', inputType: 'text', tags: ['a'], jobId: 'j6' },
          { llm, agentName: 'test', agentDescription: '', signal: controller.signal },
        ),
      ).rejects.toThrow('Job aborted');

      expect(llm.completeWithTools).not.toHaveBeenCalled();
    });
  });

  describe('runTool (subprocess)', () => {
    it('runs script and returns stdout', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'skill-tool-'));
      const scriptPath = join(tmp, 'greet.sh');
      writeFileSync(scriptPath, '#!/bin/sh\necho "Hello $1"');
      chmodSync(scriptPath, 0o755);

      try {
        const llm = makeMockLlm([
          {
            type: 'tool_use',
            calls: [{ id: 'c1', name: 'greet', arguments: { name: 'World' } }],
            assistantMessage: { role: 'assistant', content: 'calling' },
          },
          { type: 'text', text: 'done' },
        ]);

        const skill = new ScriptSkill(
          'greet',
          'desc',
          ['a'],
          0,
          undefined,
          undefined,
          tmp,
          'prompt',
          [
            {
              name: 'greet',
              description: 'Greet',
              command: [scriptPath],
              parameters: [{ name: 'name', description: 'Name', required: true }],
            },
          ],
          10,
        );

        await skill.execute(
          { data: 'greet world', inputType: 'text', tags: ['a'], jobId: 'j7' },
          { llm, agentName: 'test', agentDescription: '' },
        );

        const toolResults = (llm.formatToolResultMessages as any).mock.calls[0][0];
        expect(toolResults[0].content).toBe('Hello World');
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('returns error string on non-zero exit', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'skill-tool-'));
      const scriptPath = join(tmp, 'fail.sh');
      writeFileSync(scriptPath, '#!/bin/sh\necho "oh no" >&2\nexit 1');
      chmodSync(scriptPath, 0o755);

      try {
        const llm = makeMockLlm([
          {
            type: 'tool_use',
            calls: [{ id: 'c1', name: 'fail', arguments: {} }],
            assistantMessage: { role: 'assistant', content: 'calling' },
          },
          { type: 'text', text: 'handled' },
        ]);

        const skill = new ScriptSkill(
          'fail',
          'desc',
          ['a'],
          0,
          undefined,
          undefined,
          tmp,
          'prompt',
          [{ name: 'fail', description: 'Fail', command: [scriptPath] }],
          10,
        );

        await skill.execute(
          { data: 'test', inputType: 'text', tags: ['a'], jobId: 'j8' },
          { llm, agentName: 'test', agentDescription: '' },
        );

        const toolResults = (llm.formatToolResultMessages as any).mock.calls[0][0];
        expect(toolResults[0].content).toContain('Error (exit 1)');
        expect(toolResults[0].content).toContain('oh no');
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('returns error on missing command (ENOENT)', async () => {
      const llm = makeMockLlm([
        {
          type: 'tool_use',
          calls: [{ id: 'c1', name: 'missing', arguments: {} }],
          assistantMessage: { role: 'assistant', content: 'calling' },
        },
        { type: 'text', text: 'handled' },
      ]);

      const skill = new ScriptSkill(
        'missing',
        'desc',
        ['a'],
        0,
        undefined,
        undefined,
        '/tmp',
        'prompt',
        [{ name: 'missing', description: 'Missing', command: ['/nonexistent/binary'] }],
        10,
      );

      await skill.execute(
        { data: 'test', inputType: 'text', tags: ['a'], jobId: 'j9' },
        { llm, agentName: 'test', agentDescription: '' },
      );

      const toolResults = (llm.formatToolResultMessages as any).mock.calls[0][0];
      expect(toolResults[0].content).toContain('Error:');
    });

    it('does not interpret shell metacharacters (command injection safe)', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'skill-tool-'));
      const scriptPath = join(tmp, 'echo.sh');
      writeFileSync(scriptPath, '#!/bin/sh\necho "$1"');
      chmodSync(scriptPath, 0o755);

      try {
        const llm = makeMockLlm([
          {
            type: 'tool_use',
            calls: [{ id: 'c1', name: 'echo', arguments: { msg: '$(whoami); rm -rf /' } }],
            assistantMessage: { role: 'assistant', content: 'calling' },
          },
          { type: 'text', text: 'safe' },
        ]);

        const skill = new ScriptSkill(
          'safe',
          'desc',
          ['a'],
          0,
          undefined,
          undefined,
          tmp,
          'prompt',
          [
            {
              name: 'echo',
              description: 'Echo',
              command: [scriptPath],
              parameters: [{ name: 'msg', description: 'Msg', required: true }],
            },
          ],
          10,
        );

        await skill.execute(
          { data: 'test', inputType: 'text', tags: ['a'], jobId: 'j10' },
          { llm, agentName: 'test', agentDescription: '' },
        );

        const toolResults = (llm.formatToolResultMessages as any).mock.calls[0][0];
        // Shell metacharacters should be passed as literal strings, not interpreted
        expect(toolResults[0].content).toBe('$(whoami); rm -rf /');
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('kills active tool spawn on abort signal', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'skill-abort-'));
      const scriptPath = join(tmp, 'sleep.sh');
      writeFileSync(scriptPath, '#!/bin/sh\nexec sleep 30');
      chmodSync(scriptPath, 0o755);

      try {
        const llm = makeMockLlm([
          {
            type: 'tool_use',
            calls: [{ id: 'c1', name: 'slow', arguments: {} }],
            assistantMessage: { role: 'assistant', content: 'calling' },
          },
        ]);

        const skill = new ScriptSkill(
          'abort-active',
          'desc',
          ['a'],
          0,
          undefined,
          undefined,
          tmp,
          'prompt',
          [{ name: 'slow', description: 'Slow command', command: [scriptPath] }],
          10,
        );

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);

        const startTime = Date.now();
        await expect(
          skill.execute(
            { data: 'test', inputType: 'text', tags: ['a'], jobId: 'j-abort-active' },
            { llm, agentName: 'test', agentDescription: '', signal: controller.signal },
          ),
        ).rejects.toThrow('Job aborted');

        // Should abort quickly, not wait 30 seconds
        expect(Date.now() - startTime).toBeLessThan(5000);
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('passes non-first params as --name value flags', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'skill-tool-'));
      const scriptPath = join(tmp, 'args.sh');
      // Print all arguments to verify ordering
      writeFileSync(scriptPath, '#!/bin/sh\nfor arg in "$@"; do echo "$arg"; done');
      chmodSync(scriptPath, 0o755);

      try {
        const llm = makeMockLlm([
          {
            type: 'tool_use',
            calls: [{ id: 'c1', name: 'cmd', arguments: { query: 'hello', limit: '10' } }],
            assistantMessage: { role: 'assistant', content: 'calling' },
          },
          { type: 'text', text: 'done' },
        ]);

        const skill = new ScriptSkill(
          'args',
          'desc',
          ['a'],
          0,
          undefined,
          undefined,
          tmp,
          'prompt',
          [
            {
              name: 'cmd',
              description: 'Cmd',
              command: [scriptPath],
              parameters: [
                { name: 'query', description: 'Query', required: true },
                { name: 'limit', description: 'Limit', required: false },
              ],
            },
          ],
          10,
        );

        await skill.execute(
          { data: 'test', inputType: 'text', tags: ['a'], jobId: 'j11' },
          { llm, agentName: 'test', agentDescription: '' },
        );

        const toolResults = (llm.formatToolResultMessages as any).mock.calls[0][0];
        const lines = toolResults[0].content.split('\n');
        // First required param is positional
        expect(lines[0]).toBe('hello');
        // Second param uses --name value
        expect(lines[1]).toBe('--limit');
        expect(lines[2]).toBe('10');
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });
  });
});
