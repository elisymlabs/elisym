import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECKOUT_STATES as LOADER_STATES } from '../../checkout/src/embed/v3/protocol';
import { CHECKOUT_STATES, V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '../src';

describe('the pinned v3 loader', () => {
  it('pins the integrity of the checkout published as v3', () => {
    const published = readFileSync(
      new URL('../../checkout/src/embed/v3.sri', import.meta.url),
      'utf8',
    ).trim();
    expect(V3_LOADER_INTEGRITY).toBe(published);
  });

  it('loads v3 from the production checkout', () => {
    expect(V3_LOADER_SRC).toBe('https://pay.elisym.network/v3/embed.js');
  });

  it('knows the states the v3 loader relays', () => {
    expect([...CHECKOUT_STATES]).toEqual([...LOADER_STATES]);
  });
});
