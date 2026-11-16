import { describe, expect, it } from 'vitest';
import { apiBase } from '../src/constants';
import * as signer from '../src/lib/signer';

describe('the API base', () => {
  it('is the page origin unless a development override is set', () => {
    expect(apiBase(undefined, 'https://api.askr.elisym.network')).toBe(
      'https://api.askr.elisym.network',
    );
    expect(apiBase('', 'https://admin.example')).toBe('https://admin.example');
    expect(apiBase('http://localhost:8787/', 'https://admin.example')).toBe(
      'http://localhost:8787',
    );
    expect(apiBase()).toBe(window.location.origin);
  });
});

describe('signing in', () => {
  it('takes a secret key only: no browser extension signer is offered', () => {
    expect(Object.keys(signer)).not.toContain('extensionSigner');
    expect(Object.keys(signer)).not.toContain('windowNostr');
  });
});
