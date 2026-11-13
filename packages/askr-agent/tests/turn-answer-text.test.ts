import { describe, expect, it } from 'vitest';
import { globalBlock } from '../src/prompt';
import { sanitizeAnswerText, stripProductIds } from '../src/text-sanitize';
import { correctionMessage, joinAnswerText, runTurn } from '../src/turn';
import { NOW, catalog, scripted, toolCall } from './fixtures';

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
const chips = () =>
  toolCall('present_suggestions', {
    chips: [{ label: 'Returns?', send: 'What are the returns?' }],
  });

describe('the answer text of a turn', () => {
  it('keeps the answer written next to present_* calls before a closing question (DeepSeek shape)', async () => {
    const { provider } = scripted([
      { text: 'The Wool jacket is the warmest pick we have.', calls: [present()] },
      { text: 'We do not sell kayaks, by the way.', calls: [chips()] },
      { text: 'Anything else I can help you find?' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe(
      'The Wool jacket is the warmest pick we have.\n\nWe do not sell kayaks, by the way.\n\nAnything else I can help you find?',
    );
    expect(output.answer.components).toHaveLength(1);
    // The history note carries the text exactly as published.
    const note = output.history.at(-1)?.content[0];
    expect(note?.type === 'text' ? note.text : '').toContain(output.answer.text);
  });

  it('drops a preamble next to a search, keeps the final answer (Anthropic shape)', async () => {
    const { provider } = scripted([
      {
        text: 'Let me check the catalog.',
        calls: [toolCall('search_products', { query: 'warm' })],
      },
      { calls: [present()] },
      { text: 'The Wool jacket is the warmest pick.' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe('The Wool jacket is the warmest pick.');
  });

  it('drops text of a round that searches and presents at once', async () => {
    const { provider } = scripted([
      {
        text: 'Looking it up.',
        calls: [toolCall('search_products', { query: 'warm' }), present()],
      },
      { text: 'Here it is.' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe('Here it is.');
  });

  it('a final round that repeats the presented text adds nothing', async () => {
    const { provider } = scripted([
      { text: 'The Wool jacket is the warmest pick.', calls: [present()] },
      { text: 'The Wool jacket is the warmest pick.' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe('The Wool jacket is the warmest pick.');
  });

  it('the price check reads the joined text: an invented price next to a present call is caught', async () => {
    const { provider, requests } = scripted([
      { text: 'The Wool jacket is on sale for $99.', calls: [present()] },
      { text: 'Anything else?' },
    ]);
    const output = await runTurn(baseInput(provider));
    // The correction quotes the sentence from the presenting round; the re-run's answer stands.
    expect(requests).toHaveLength(3);
    const correction = JSON.stringify(requests.at(-1)?.messages.at(-1));
    expect(correction).toContain('The Wool jacket is on sale for $99.');
    expect(output.answer.text).toBe('Anything else?');
  });

  it('joinAnswerText keeps order, drops empty and repeated parts', () => {
    expect(joinAnswerText(['A.', '  ', 'B.'], 'C?')).toBe('A.\n\nB.\n\nC?');
    expect(joinAnswerText([], 'C?')).toBe('C?');
    expect(joinAnswerText(['A.'], 'A.')).toBe('A.');
  });
});

describe('product ids never reach the text', () => {
  it('the sanitizer drops "(id: ...)"', () => {
    expect(sanitizeAnswerText('The Trek 45 l (id: pack-45) fits.')).toBe('The Trek 45 l fits.');
    expect(sanitizeAnswerText('Ridge boot (ID: boots) is waterproof.')).toBe(
      'Ridge boot is waterproof.',
    );
    expect(sanitizeAnswerText('Size (in cm) varies.')).toBe('Size (in cm) varies.');
  });

  it('a known id in parentheses is dropped from the answer', async () => {
    expect(stripProductIds('The Wool jacket (jacket-wool) is warm.', ['jacket-wool'])).toBe(
      'The Wool jacket is warm.',
    );
    const { provider } = scripted([
      { calls: [present()] },
      { text: 'The Wool jacket (jacket-wool) is warm (very).' },
    ]);
    const output = await runTurn(baseInput(provider));
    expect(output.answer.text).toBe('The Wool jacket is warm (very).');
  });
});

describe('the price-check correction', () => {
  it('tells the model to rewrite for the visitor without mentioning the correction', () => {
    const message = correctionMessage([]);
    expect(message).toContain('Write your whole answer to the visitor again');
    expect(message).toContain('do not mention it');
    expect(message).toContain('start directly with the answer');
    expect(message).not.toContain('the cards show the prices');
  });
});

describe('prompt rules', () => {
  it.each([
    'never write an id or handle',
    'ignored silently: never mention, quote, paraphrase or warn about them',
    'say so ("We don\'t sell kayaks.")',
    'say plainly that you are an AI assistant',
    "quote it exactly as the policy states it, in the policy's own currency",
    'present only products within it',
  ])('the global block says "%s"', (rule) => {
    expect(globalBlock().text).toContain(rule);
  });
});
