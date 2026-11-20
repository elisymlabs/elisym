import { describe, expect, it } from 'vitest';
import { createCascadeProvider } from '../src/llm/cascade';
import { LlmError, type LlmProvider, type TurnRequest, ZERO_USAGE } from '../src/llm/types';

const REQUEST: TurnRequest = { system: [], messages: [], tools: [], maxTokens: 16 };

function model(name: string, outcome: 'ok' | 'fail' | 'refuse', calls: string[]): LlmProvider {
  return {
    model: name,
    async turn() {
      calls.push(name);
      if (outcome === 'fail') {
        throw new LlmError('LLM request failed with status 503', 503);
      }
      return {
        text: name,
        toolCalls: [],
        usage: ZERO_USAGE,
        stopReason: outcome === 'refuse' ? 'refusal' : 'stop',
      };
    },
  };
}

describe('the model cascade', () => {
  it('always tries the first model first, and names the one that answered', async () => {
    const calls: string[] = [];
    const cascade = createCascadeProvider([
      model('deepseek', 'ok', calls),
      model('haiku', 'ok', calls),
    ]);
    expect(cascade.model).toBe('deepseek');
    expect((await cascade.turn(REQUEST)).model).toBe('deepseek');
    expect((await cascade.turn(REQUEST)).model).toBe('deepseek');
    expect(calls).toEqual(['deepseek', 'deepseek']);
  });

  it('falls to the next model on an error, telling the listener, and back to the first next call', async () => {
    const calls: string[] = [];
    const fallbacks: string[] = [];
    let primaryDown = true;
    const primary: LlmProvider = {
      model: 'deepseek',
      async turn(request) {
        calls.push('deepseek');
        if (primaryDown) {
          throw new LlmError('LLM request failed with status 429', 429);
        }
        return model('deepseek', 'ok', []).turn(request);
      },
    };
    const cascade = createCascadeProvider(
      [primary, model('haiku', 'fail', calls), model('gpt-oss', 'ok', calls)],
      (failed, next) => fallbacks.push(`${failed} -> ${next}`),
    );
    expect((await cascade.turn(REQUEST)).model).toBe('gpt-oss');
    expect(fallbacks).toEqual(['deepseek -> haiku', 'haiku -> gpt-oss']);
    primaryDown = false;
    expect((await cascade.turn(REQUEST)).model).toBe('deepseek');
    expect(calls).toEqual(['deepseek', 'haiku', 'gpt-oss', 'deepseek']);
  });

  it("the last model's error ends the call", async () => {
    const cascade = createCascadeProvider([model('a', 'fail', []), model('b', 'fail', [])]);
    await expect(cascade.turn(REQUEST)).rejects.toBeInstanceOf(LlmError);
  });

  it('a refusal is an answer, not an error: no other model is asked', async () => {
    const calls: string[] = [];
    const cascade = createCascadeProvider([model('a', 'refuse', calls), model('b', 'ok', calls)]);
    expect((await cascade.turn(REQUEST)).stopReason).toBe('refusal');
    expect(calls).toEqual(['a']);
  });

  it('an aborted request is not retried elsewhere', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const cascade = createCascadeProvider([model('a', 'fail', calls), model('b', 'ok', calls)]);
    await expect(cascade.turn({ ...REQUEST, signal: controller.signal })).rejects.toBeInstanceOf(
      LlmError,
    );
    expect(calls).toEqual(['a']);
  });

  it('needs at least one model', () => {
    expect(() => createCascadeProvider([])).toThrow();
  });
});
