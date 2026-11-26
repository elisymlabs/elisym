import { describe, expect, it } from 'vitest';
import {
  MAX_AHEAD_SECS,
  type TemplateCheckInput,
  checkOwnerTemplate,
} from '../../src/hosted/lib/owner-event-check';
import type { Payout } from '../../src/hosted/lib/types';
import { OPERATOR, STORE_PUBKEY } from './fakes';

const NOW = 1_800_000_000;
const SOLANA =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const BASE = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SOLANA_ADDRESS = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
const EVM_ADDRESS = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const PAYOUTS: Payout[] = [
  { caip19: SOLANA, address: SOLANA_ADDRESS, signature: 'solsig' },
  { caip19: BASE, address: EVM_ADDRESS, signature: '0xevmsig' },
];

function payoutList(overrides: Record<string, unknown> = {}) {
  return {
    kind: 10133,
    created_at: NOW,
    content: '',
    tags: PAYOUTS.map((payout) => ['accept', payout.caip19, payout.address, payout.signature]),
    ...overrides,
  };
}

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    kind: 30490,
    created_at: NOW,
    content: '',
    tags: [
      ['d', STORE_PUBKEY],
      ['p', STORE_PUBKEY],
      ['mode', 'hosted', OPERATOR],
    ],
    ...overrides,
  };
}

function check(kind: 10133 | 30490, template: unknown, extra: Partial<TemplateCheckInput> = {}) {
  return checkOwnerTemplate({
    kind,
    template,
    payouts: PAYOUTS,
    storePubkey: STORE_PUBKEY,
    operator: OPERATOR,
    localNow: NOW,
    ...extra,
  });
}

describe('the A13 check of a payout list (10133)', () => {
  it('passes the exact list of the rows, in order, and hands back only the template fields', () => {
    const template = payoutList({ extra: 'field' });
    const checked = check(10133, template);
    expect(checked).toEqual({
      ok: true,
      template: { kind: 10133, created_at: NOW, content: '', tags: payoutList().tags },
    });
  });

  it('takes an EVM address equal but for its case, and a past date', () => {
    const tags = payoutList().tags.map((tag) =>
      tag[1] === BASE
        ? ['accept', BASE, EVM_ADDRESS.toUpperCase().replace('0X', '0x'), '0xevmsig']
        : tag,
    );
    expect(check(10133, payoutList({ tags, created_at: NOW - 86_400 })).ok).toBe(true);
  });

  it('refuses a Solana address that differs only in case', () => {
    const tags = payoutList().tags.map((tag) =>
      tag[1] === SOLANA ? ['accept', SOLANA, SOLANA_ADDRESS.toLowerCase(), 'solsig'] : tag,
    );
    expect(check(10133, payoutList({ tags }))).toEqual({ ok: false, problem: 'payouts' });
  });

  it.each([
    [
      'another address',
      [
        ['accept', SOLANA, 'AttackerAddress111111111111111111111111111', 'solsig'],
        ['accept', BASE, EVM_ADDRESS, '0xevmsig'],
      ],
    ],
    [
      'another coin',
      [
        ['accept', BASE, SOLANA_ADDRESS, 'solsig'],
        ['accept', BASE, EVM_ADDRESS, '0xevmsig'],
      ],
    ],
    [
      'another signature',
      [
        ['accept', SOLANA, SOLANA_ADDRESS, 'other'],
        ['accept', BASE, EVM_ADDRESS, '0xevmsig'],
      ],
    ],
    [
      'no signature',
      [
        ['accept', SOLANA, SOLANA_ADDRESS],
        ['accept', BASE, EVM_ADDRESS, '0xevmsig'],
      ],
    ],
    [
      'another order',
      [
        ['accept', BASE, EVM_ADDRESS, '0xevmsig'],
        ['accept', SOLANA, SOLANA_ADDRESS, 'solsig'],
      ],
    ],
    ['a row missing', [['accept', SOLANA, SOLANA_ADDRESS, 'solsig']]],
    ['a row added', [...payoutList().tags, ['accept', SOLANA, SOLANA_ADDRESS, 'solsig']]],
    [
      'a fifth item',
      [
        ['accept', SOLANA, SOLANA_ADDRESS, 'solsig', 'x'],
        ['accept', BASE, EVM_ADDRESS, '0xevmsig'],
      ],
    ],
    [
      'no address',
      [
        ['accept', SOLANA],
        ['accept', BASE, EVM_ADDRESS, '0xevmsig'],
      ],
    ],
  ])('refuses a list with %s', (_name, tags) => {
    expect(check(10133, payoutList({ tags }))).toEqual({ ok: false, problem: 'payouts' });
  });

  it('refuses a list with another tag', () => {
    const tags = [...payoutList().tags, ['payto', 'x', 'y']];
    expect(check(10133, payoutList({ tags }))).toEqual({ ok: false, problem: 'tags' });
    const expiring = [...payoutList().tags, ['expiration', String(NOW + 60)]];
    expect(check(10133, payoutList({ tags: expiring }))).toEqual({ ok: false, problem: 'tags' });
  });

  it('takes an unsigned row only as an unsigned tag', () => {
    const payouts = [{ caip19: SOLANA, address: SOLANA_ADDRESS }];
    expect(
      check(10133, payoutList({ tags: [['accept', SOLANA, SOLANA_ADDRESS]] }), { payouts }).ok,
    ).toBe(true);
  });
});

describe('the A13 check of an authorization (30490)', () => {
  it('passes d/p = this store key and mode hosted with the committed operator', () => {
    expect(check(30490, authorization()).ok).toBe(true);
  });

  it('refuses another store', () => {
    const other = 'b'.repeat(64);
    for (const tags of [
      [
        ['d', other],
        ['p', STORE_PUBKEY],
        ['mode', 'hosted', OPERATOR],
      ],
      [
        ['d', STORE_PUBKEY],
        ['p', other],
        ['mode', 'hosted', OPERATOR],
      ],
      [
        ['d', STORE_PUBKEY, 'x'],
        ['p', STORE_PUBKEY],
        ['mode', 'hosted', OPERATOR],
      ],
    ]) {
      expect(check(30490, authorization({ tags }))).toEqual({ ok: false, problem: 'store' });
    }
  });

  it('refuses another operator or mode', () => {
    for (const mode of [
      ['mode', 'hosted', 'evil.example'],
      ['mode', 'self-host'],
      ['mode', 'hosted'],
      ['mode', 'hosted', OPERATOR, 'x'],
      ['mode', 'self-host', OPERATOR],
    ]) {
      const tags = [['d', STORE_PUBKEY], ['p', STORE_PUBKEY], mode];
      expect(check(30490, authorization({ tags }))).toEqual({ ok: false, problem: 'operator' });
    }
  });

  it('refuses an expiration or any other tag, and tags out of shape', () => {
    for (const tags of [
      [...authorization().tags, ['expiration', String(NOW + 3600)]],
      [...authorization().tags, ['alt', 'x']],
      [
        ['p', STORE_PUBKEY],
        ['d', STORE_PUBKEY],
        ['mode', 'hosted', OPERATOR],
      ],
      [
        ['d', STORE_PUBKEY],
        ['p', STORE_PUBKEY],
        ['expiration', String(NOW + 3600)],
      ],
      [
        ['d', STORE_PUBKEY],
        ['p', STORE_PUBKEY],
      ],
      [],
    ]) {
      expect(check(30490, authorization({ tags }))).toEqual({ ok: false, problem: 'tags' });
    }
  });
});

describe('the A13 check of any template', () => {
  it('refuses another kind than asked', () => {
    expect(check(10133, authorization())).toEqual({ ok: false, problem: 'kind' });
    expect(check(30490, payoutList())).toEqual({ ok: false, problem: 'kind' });
    expect(check(30490, authorization({ kind: 1 }))).toEqual({ ok: false, problem: 'kind' });
  });

  it('refuses content', () => {
    expect(check(30490, authorization({ content: 'x' }))).toEqual({
      ok: false,
      problem: 'content',
    });
    expect(check(10133, payoutList({ content: ' ' }))).toEqual({ ok: false, problem: 'content' });
  });

  it('takes a date up to ten minutes ahead of the local clock, and no later', () => {
    expect(check(30490, authorization({ created_at: NOW + MAX_AHEAD_SECS })).ok).toBe(true);
    expect(check(30490, authorization({ created_at: NOW + MAX_AHEAD_SECS + 1 }))).toEqual({
      ok: false,
      problem: 'date',
    });
    expect(check(10133, payoutList({ created_at: NOW + 10 * 365 * 86_400 }))).toEqual({
      ok: false,
      problem: 'date',
    });
  });

  it.each([
    ['not an object', 'template'],
    ['null', null],
    ['an array', []],
    ['no kind', { created_at: NOW, content: '', tags: [] }],
    ['a text date', { kind: 30490, created_at: String(NOW), content: '', tags: [] }],
    ['a fractional date', { kind: 30490, created_at: NOW + 0.5, content: '', tags: [] }],
    ['a negative date', { kind: 30490, created_at: -1, content: '', tags: [] }],
    ['no content', { kind: 30490, created_at: NOW, tags: [] }],
    ['tags not a list', { kind: 30490, created_at: NOW, content: '', tags: {} }],
    ['a tag not a list', { kind: 30490, created_at: NOW, content: '', tags: ['d'] }],
    ['a number in a tag', { kind: 30490, created_at: NOW, content: '', tags: [['d', 1]] }],
  ])('refuses a template that is %s', (_name, template) => {
    expect(check(30490, template)).toEqual({ ok: false, problem: 'malformed' });
  });
});
