import { LIMITS } from '@elisym/askr';
import { describe, expect, it, vi } from 'vitest';
import { globalBlock } from '../src/prompt';
import * as sanitize from '../src/text-sanitize';
import { executeTool, newTurnState } from '../src/tools';
import { runTurn } from '../src/turn';
import { NOW, catalog, expectLinear, scripted, toolCall } from './fixtures';

const { sanitizeAnswerText, stripProductIds, idsToStrip } = sanitize;

/** The longest text the answer sanitizer was given, across the whole file. */
const seen = vi.hoisted(() => ({ longest: 0 }));
vi.mock('../src/text-sanitize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/text-sanitize')>();
  return {
    ...actual,
    sanitizeAnswerText: (text: string) => {
      seen.longest = Math.max(seen.longest, text.length);
      return actual.sanitizeAnswerText(text);
    },
  };
});

const products = (ids: readonly string[]) => idsToStrip(ids, []);

function baseInput(provider: ReturnType<typeof scripted>['provider']) {
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

const present = () => toolCall('present_products', { picks: [{ id: 'jacket-wool' }] });

describe('MINOR-1. one scan, whatever the number of ids', () => {
  const many = idsToStrip(
    Array.from({ length: 200_000 }, (_, index) => `item-${index}`),
    Array.from({ length: 200_000 }, (_, index) => `variant-${index}`),
  );

  it('strips from a large id set', () => {
    expect(stripProductIds('The pack (item-199999) and (sku: variant-7) fit.', many)).toBe(
      'The pack and fit.',
    );
  });

  it('a hundred strings against 400k ids stay fast', () => {
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      stripProductIds(`Pick ${index} (item-${index}) (not-an-id) is warm (very).`, many);
    }
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('linear in the text, with a large id set', () => {
    expectLinear((scale) => {
      stripProductIds(`${'(not-an-id) '.repeat(2_000 * scale)}(item-1)`, many);
    });
  });
});

describe('MINOR-2. odd ids and where stripping happens', () => {
  it('ids with regex metacharacters neither throw nor strip something else', () => {
    const odd = products(['a.b', 'a)b', 'x(y', 'a*b']);
    expect(stripProductIds('Take (aXb) and (aab).', odd)).toBe('Take (aXb) and (aab).');
    expect(stripProductIds('Take (a.b) and (a*b).', odd)).toBe('Take and.');
    // An id with a parenthesis can never be written in one pair of them: left alone.
    expect(stripProductIds('Take (a)b) and (x(y).', odd)).toBe('Take (a)b) and (x(y).');
  });

  it('the sanitizer never reads more than four times the answer cap (A15/A16)', async () => {
    seen.longest = 0;
    const { provider } = scripted([
      { text: 'x'.repeat(LIMITS.ANSWER_TEXT_CHARS * 10), calls: [present()] },
      { text: 'Anything else?' },
    ]);
    const output = await runTurn(baseInput(provider));
    // The spy saw the joined text, cut to exactly the bound.
    expect(seen.longest).toBe(LIMITS.ANSWER_TEXT_CHARS * 4);
    expect(output.answer.text.length).toBeLessThanOrEqual(LIMITS.ANSWER_TEXT_CHARS);
  });

  it('a full-width or zero-width id in a reason is stripped (A21)', () => {
    const state = newTurnState(new Set(['jacket-wool', 'scarf']), [], []);
    executeTool(
      catalog(),
      state,
      toolCall('present_products', {
        picks: [
          { id: 'jacket-wool', reason: 'Warm （jacket-wool）' },
          { id: 'scarf', reason: 'Soft (jacket​-wool) wool' },
        ],
      }),
    );
    expect(state.components).toEqual([
      expect.objectContaining({
        picks: [
          expect.objectContaining({ reason: 'Warm' }),
          expect.objectContaining({ reason: 'Soft wool' }),
        ],
      }),
    ]);
  });

  it('a reason at the cap ending with an id leaves no partial id: strip before the cap (A22)', () => {
    // ㎏ folds to "kg": NFKC makes the reason one character longer than the cap.
    const tail = ' (jacket-wool)';
    const reason = `㎏${'a'.repeat(LIMITS.REASON_CHARS - 1 - tail.length)}${tail}`;
    expect(reason).toHaveLength(LIMITS.REASON_CHARS);
    const state = newTurnState(new Set(['jacket-wool']), [], []);
    executeTool(
      catalog(),
      state,
      toolCall('present_products', { picks: [{ id: 'jacket-wool', reason }] }),
    );
    const shown = JSON.stringify(state.components);
    expect(shown).not.toContain('(jacket');
    expect(shown).toContain(`kg${'a'.repeat(LIMITS.REASON_CHARS - 1 - tail.length)}"`);
  });

  it('a variant id in the final text is stripped (A23)', async () => {
    const { provider } = scripted([
      { calls: [present()] },
      { text: 'The red scarf (scarf-red) is soft.' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe('The red scarf is soft.');
  });
});

describe('MINOR-3/4. plain-word variant ids and short ids', () => {
  const colors = idsToStrip(['pack-45'], ['black', 'navy', 'over budget', 'v-2']);

  it('a plain-word variant id is a parenthetical when written alone', () => {
    expect(stripProductIds('Comes in two colors (black) and (navy).', colors)).toBe(
      'Comes in two colors (black) and (navy).',
    );
    expect(stripProductIds('The pack (over budget) is the closest.', colors)).toBe(
      'The pack (over budget) is the closest.',
    );
  });

  it('a plain-word variant id is stripped with a label; an id-shaped one alone too', () => {
    expect(stripProductIds('Black (sku: black) is back.', colors)).toBe('Black is back.');
    expect(stripProductIds('Version two (v-2) is lighter.', colors)).toBe(
      'Version two is lighter.',
    );
  });

  it('Size (xl) fits: a two-letter id is never stripped', () => {
    expect(stripProductIds('Size (xl) fits.', products(['xl']))).toBe('Size (xl) fits.');
  });
});

describe('NIT-3. ids are normalized like the text', () => {
  it('a full-width id matches its folded form', () => {
    expect(stripProductIds(sanitizeAnswerText('Part (Ｘ-01) fits.'), products(['Ｘ-01']))).toBe(
      'Part fits.',
    );
  });
});

describe('NIT-4. suggestions that clean to nothing show nothing', () => {
  it('returns shown false as an error, keeps earlier chips', () => {
    const state = newTurnState(new Set(), [], []);
    executeTool(catalog(), state, toolCall('present_suggestions', { chips: ['Returns?'] }));
    const outcome = executeTool(
      catalog(),
      state,
      toolCall('present_suggestions', { chips: ['​', '​​'] }),
    );
    expect(outcome.isError).toBe(true);
    expect(JSON.parse(outcome.content)).toMatchObject({ shown: false });
    expect(state.chips).toEqual(['Returns?']);
  });

  it('its round text is dropped', async () => {
    const { provider } = scripted([
      { text: 'Pick one below.', calls: [toolCall('present_suggestions', { chips: ['​'] })] },
      { text: 'Anything else?' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe('Anything else?');
  });
});

describe('the history note never reaches the answer', () => {
  it('the sanitizer drops a bracketed span, swapped or not', () => {
    expect(
      sanitizeAnswerText('The tent is great [shown, in order: 1. tent-1p (Trail tent)] for one.'),
    ).toBe('The tent is great for one.');
    expect(sanitizeAnswerText('See ⟦shown, in order: 1. tent-1p (Trail tent)⟧ below.')).toBe(
      'See below.',
    );
    // An unbalanced bracket stays, as its lookalike.
    expect(sanitizeAnswerText('Sizes [S, M and L.')).toBe('Sizes ⟦S, M and L.');
  });

  it('is linear on unclosed and repeated brackets', () => {
    expectLinear((scale) => {
      sanitizeAnswerText(`[${'a'.repeat(20_000 * scale)}`);
      sanitizeAnswerText('[a'.repeat(10_000 * scale));
      sanitizeAnswerText(`${' '.repeat(10_000 * scale)}[`);
    });
  });

  it('component strings drop it too', () => {
    const state = newTurnState(new Set(['jacket-wool']), [], []);
    executeTool(
      catalog(),
      state,
      toolCall('present_products', {
        picks: [{ id: 'jacket-wool', reason: 'Warm [shown, in order: 1. jacket-wool] wool' }],
      }),
    );
    expect(state.components).toEqual([
      expect.objectContaining({ picks: [expect.objectContaining({ reason: 'Warm wool' })] }),
    ]);
  });

  it('a turn whose model copies the note publishes it without the note', async () => {
    const { provider } = scripted([
      { text: 'It costs what its card says. [shown, in order: 1. jacket-wool (Wool jacket)]' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe('It costs what its card says.');
  });

  it('the prompt says notes are never repeated and cards are presented again', () => {
    const text = globalBlock().text;
    expect(text).toContain(
      'A note like "[shown, in order: ...]" in an earlier assistant turn records what was shown then; never repeat it.',
    );
    expect(text).toContain(
      'Refer to a card only when you present it in this answer: if the visitor asks about a product shown earlier, present it again.',
    );
  });
});
