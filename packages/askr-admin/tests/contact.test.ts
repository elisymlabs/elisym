import { describe, expect, it } from 'vitest';
import { contactEmailOf } from '../src/lib/contact';

describe('contact email', () => {
  it('trims and lowercases as the server stores it, so a saved email reads as unchanged', () => {
    expect(contactEmailOf('  Owner@Shop.Example ')).toBe('owner@shop.example');
  });

  it('refuses what the server refuses', () => {
    for (const typed of [
      '',
      'owner',
      'owner@shop',
      'a b@shop.example',
      `${'a'.repeat(250)}@x.io`,
    ]) {
      expect(contactEmailOf(typed)).toBeUndefined();
    }
  });
});
