// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { errorMessage, invalidItemIssues } from '../src/lib/errors';

const SERVER = new URL('../../askr-server/src/', import.meta.url);
const API_SOURCE = readFileSync(new URL('admin/api.ts', SERVER), 'utf8');
const NIP98_SOURCE = readFileSync(new URL('admin/nip98.ts', SERVER), 'utf8');
const STORES_SOURCE = readFileSync(new URL('state/stores.ts', SERVER), 'utf8');

const GENERIC = errorMessage(new ApiError(500, 'unexpected'));

function matches(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1] ?? ''))];
}

/** Every `{ error: '...' }` code the admin API returns. */
const CODES = matches(API_SOURCE, /error: '([a-z_]+)'/g);
/** Every reason of an unauthorized answer: the `AuthCheck` union in nip98.ts, plus replay. */
const AUTH_REASONS = [
  ...matches(/reason:\s*((?:'[a-z_]+'\s*\|?\s*)+);/.exec(NIP98_SOURCE)?.[1] ?? '', /'([a-z_]+)'/g),
  'replay',
];
/** Every reason of a bad_event answer: `refusal()` and `addEvents`. */
const EVENT_REASONS = [
  ...new Set([
    ...matches(
      API_SOURCE.slice(
        API_SOURCE.indexOf('function refusal'),
        API_SOURCE.indexOf('export function createAdminApi'),
      ),
      /(?:return|:)\s*'([a-z_]+)'/g,
    ),
    ...matches(
      STORES_SOURCE.slice(
        STORES_SOURCE.indexOf('type AddEventsResult'),
        STORES_SOURCE.indexOf('interface StoreEventStatus'),
      ),
      /'([a-z_]+)'/g,
    ).filter((reason) => reason !== 'too_many_events'),
  ]),
];

describe('error messages', () => {
  it('found the codes in the server source', () => {
    expect(CODES).toEqual(
      expect.arrayContaining([
        'unauthorized',
        'no_store',
        'bad_event',
        'sync_running',
        'inactive',
        'no_connector',
      ]),
    );
    expect(AUTH_REASONS).toEqual(expect.arrayContaining(['missing', 'stale', 'payload', 'replay']));
    expect(EVENT_REASONS).toEqual(
      expect.arrayContaining(['config_assistant', 'deletion_target', 'stale_config']),
    );
  });

  it.each(CODES.filter((code) => code !== 'unauthorized' && code !== 'bad_event'))(
    'says something specific for %s',
    (code) => {
      const message = errorMessage(new ApiError(409, code, { message: 'relay said no', max: 10 }));
      expect(message).not.toBe(GENERIC);
      expect(message).not.toContain('_');
    },
  );

  it.each(AUTH_REASONS)('explains an unauthorized %s', (reason) => {
    const message = errorMessage(new ApiError(401, 'unauthorized', { reason }));
    expect(message).not.toBe(
      errorMessage(new ApiError(401, 'unauthorized', { reason: 'something-new' })),
    );
  });

  it.each(EVENT_REASONS)('explains a refused event: %s', (reason) => {
    const message = errorMessage(new ApiError(400, 'bad_event', { reason, id: 'x' }));
    expect(message).not.toBe(
      errorMessage(new ApiError(400, 'bad_event', { reason: 'something-new' })),
    );
  });

  it('carries the details the server gives', () => {
    expect(errorMessage(new ApiError(400, 'too_many_products', { max: 250 }))).toContain(
      'at most 250 products',
    );
    expect(
      errorMessage(new ApiError(409, 'sync_refused', { message: 'K is not authorized' })),
    ).toContain('K is not authorized');
    expect(
      errorMessage(new ApiError(409, 'publish_refused', { message: 'rate limited' })),
    ).toContain('rate limited');
    expect(errorMessage(new ApiError(401, 'unauthorized', { reason: 'stale' }))).toContain('clock');
    expect(errorMessage(new ApiError(0, 'network'))).toContain('could not be reached');
    expect(errorMessage(new ApiError(413, 'unexpected'))).toContain('too large');
    expect(errorMessage(new Error('Shop address: bad'))).toBe('Shop address: bad');
  });

  it('lists the item problems of an invalid_items refusal', () => {
    const error = new ApiError(400, 'invalid_items', {
      issues: [
        { path: [2, 'price', 'amount'], message: 'Invalid' },
        { path: [0, 'd'], message: 'Required' },
      ],
    });
    expect(invalidItemIssues(error)).toEqual([
      'item 3: price.amount: Invalid',
      'item 1: d: Required',
    ]);
  });
});
