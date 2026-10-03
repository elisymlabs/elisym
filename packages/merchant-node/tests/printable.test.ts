import { describe, expect, it } from 'vitest';
import { printable } from '../src/printable';

describe('printing a buyer-supplied value', () => {
  it('replaces every control character, and keeps the rest', () => {
    expect(printable('buyer@example.com')).toBe('buyer@example.com');
    expect(printable('a\u001b]0;pwned\u0007@x')).toBe('a?]0;pwned?@x');
    expect(printable('\u009b31m@x\u007f')).toBe('?31m@x?');
    expect(printable('é@例え.jp')).toBe('é@例え.jp');
  });
});
