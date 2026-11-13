import { LIMITS } from '@elisym/askr';
import { describe, expect, it } from 'vitest';
import type { LlmProvider, TurnRequest, TurnResponse } from '../src/llm/types';
import { sanitizeAnswerText, stripProductIds, idsToStrip } from '../src/text-sanitize';
import { executeTool, newTurnState } from '../src/tools';
import { MAX_TOOL_ROUNDS, runTurn } from '../src/turn';
import { NOW, catalog, expectLinear, scripted, toolCall } from './fixtures';

const products = (ids: readonly string[]) => idsToStrip(ids, []);

function baseInput(provider: LlmProvider) {
  return {
    catalog: catalog(),
    provider,
    history: [],
    askId: 'a'.repeat(32),
    text: 'something warm',
    locale: 'en-US',
    sessionEnd: NOW + 3_600,
    now: NOW,
    earlierVisitorMessages: [],
    earlierPolicyPassages: [],
  };
}

const present = (id = 'jacket-wool') => toolCall('present_products', { picks: [{ id }] });
const USAGE = { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 };

describe('MAJOR. the sanitizer and the id strip are linear in the text', () => {
  it('sanitizeAnswerText on long whitespace runs before a parenthesis', () => {
    expectLinear((scale) => {
      sanitizeAnswerText(`a${' '.repeat(20_000 * scale)}(id: pack-45`);
      sanitizeAnswerText(`${' \t'.repeat(10_000 * scale)}(sku:`);
    });
  });

  it('stripProductIds on long whitespace runs before an unclosed id mention', () => {
    expectLinear((scale) => {
      stripProductIds(`a${' '.repeat(20_000 * scale)}(id: jacket-wool`, products(['jacket-wool']));
      stripProductIds(
        `${' \t'.repeat(10_000 * scale)}(jacket-wool(jacket-wool`,
        products(['jacket-wool']),
      );
    });
  });

  it('a huge joined answer is cut before the sanitizer and fits the cap', async () => {
    const { provider } = scripted([
      { text: 'x '.repeat(50_000), calls: [present()] },
      { text: 'Anything else?' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text.length).toBeLessThanOrEqual(LIMITS.ANSWER_TEXT_CHARS);
  });
});

describe('MINOR-2. text of a present round counts only when something was shown', () => {
  it('a bad id then a retry with the same text: the text appears once', async () => {
    const { provider } = scripted([
      { text: 'The Wool jacket is the warmest.', calls: [present('no-such-item')] },
      { text: 'The Wool jacket is the warmest!', calls: [present()] },
      { text: 'Anything else?' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe('The Wool jacket is the warmest!\n\nAnything else?');
  });
});

describe('MINOR-3/4. which parentheses are ids', () => {
  it('short or all-digit ids are never stripped', () => {
    expect(stripProductIds('Step (1) pick a size.', products(['1']))).toBe('Step (1) pick a size.');
    expect(stripProductIds('Size (m) fits.', products(['m']))).toBe('Size (m) fits.');
    expect(stripProductIds('Model (12345) is new.', products(['12345']))).toBe(
      'Model (12345) is new.',
    );
  });

  it('a mention at the start leaves no leading space', () => {
    expect(stripProductIds('(jacket-wool) is great.', products(['jacket-wool']))).toBe('is great.');
    expect(stripProductIds('Warm.\n(jacket-wool) is great.', products(['jacket-wool']))).toBe(
      'Warm.\nis great.',
    );
  });

  it('id and sku labels are stripped only around a known id', () => {
    expect(
      stripProductIds('The pan (Handle: oak) is nice.', products(['jacket-wool', 'oak'])),
    ).toBe('The pan (Handle: oak) is nice.');
    expect(stripProductIds('Bring (ID: passport) at pickup.', products(['jacket-wool']))).toBe(
      'Bring (ID: passport) at pickup.',
    );
    expect(stripProductIds('The pack (id: pack-45) fits.', products(['pack-45']))).toBe(
      'The pack fits.',
    );
    expect(stripProductIds('Red (SKU:scarf-red) only.', products(['scarf-red']))).toBe('Red only.');
  });

  it('a mention never spans a newline (M16/M17)', () => {
    expect(stripProductIds('The pack (id:\npack-45) fits.', products(['pack-45']))).toBe(
      'The pack (id:\npack-45) fits.',
    );
  });

  it('the sanitizer runs first: full-width parentheses and invisible characters fold (M10)', async () => {
    const { provider } = scripted([
      { calls: [present()] },
      { text: 'The Wool jacket （jacket-wool） and (id:​ jacket-wool) are warm.' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe('The Wool jacket and are warm.');
  });
});

describe('MINOR-6. component strings lose ids too', () => {
  it('reasons, titles and chips', () => {
    const shop = catalog();
    const state = newTurnState(new Set(['jacket-wool']), [], []);
    executeTool(
      shop,
      state,
      toolCall('present_products', {
        title: 'Warm picks (jacket-wool)',
        picks: [{ id: 'jacket-wool', reason: 'Wool (id: jacket-wool) is warm' }],
      }),
    );
    executeTool(
      shop,
      state,
      toolCall('present_suggestions', { chips: ['More like (scarf-red)', 'Size (m)?'] }),
    );
    expect(state.components).toEqual([
      expect.objectContaining({
        title: 'Warm picks',
        picks: [expect.objectContaining({ reason: 'Wool is warm' })],
      }),
    ]);
    expect(state.chips).toEqual(['More like', 'Size (m)?']);
  });
});

describe('MINOR-7. what the price re-run replays, and the forced round', () => {
  it('the replay carries the final round text, not the joined answer (M7)', async () => {
    const { provider, requests } = scripted([
      { text: 'The Wool jacket is the warmest.', calls: [present()] },
      { text: 'It is on sale for $99.' },
    ]);
    await runTurn(baseInput(provider));
    const rerun = requests[2]?.messages ?? [];
    const replay = rerun.at(-2);
    expect(replay?.role).toBe('assistant');
    expect(replay?.content).toEqual([{ type: 'text', text: 'It is on sale for $99.' }]);
  });

  it('the forced round text is joined after the presented text (M12)', async () => {
    let call = 0;
    const provider: LlmProvider = {
      model: 'forced',
      async turn(request: TurnRequest): Promise<TurnResponse> {
        call += 1;
        if (call === 1) {
          return {
            text: 'The Wool jacket is the warmest.',
            toolCalls: [present()],
            stopReason: 'tool_use',
            usage: USAGE,
          };
        }
        // Keeps calling tools, the forced round too.
        return {
          text: request.toolChoice === 'none' ? 'Anything else?' : 'Let me look.',
          toolCalls: [toolCall('search_products', { query: 'warm' })],
          stopReason: 'tool_use',
          usage: USAGE,
        };
      },
    };
    const output = await runTurn(baseInput(provider));
    expect(call).toBe(MAX_TOOL_ROUNDS + 1);
    expect(output.answer.text).toBe('The Wool jacket is the warmest.\n\nAnything else?');
  });
});
