import { describe, expect, it } from 'vitest';
import { cloudDecides, keyRoute, ownerAnswerOf, relaysShowAStore } from '../src/lib/key-route';

describe('where a pasted key leads', () => {
  it('follows the cloud answer first, then the relays', () => {
    const cases: [number, string | null | undefined, boolean, string][] = [
      [200, 'aaaaaaaaaaaa', false, 'cloud'],
      [200, 'aaaaaaaaaaaa', true, 'cloud'],
      [200, null, true, 'self-hosted'],
      [200, null, false, 'cloud-none'],
      [403, undefined, false, 'cloud'],
      [403, undefined, true, 'cloud'],
      [401, undefined, true, 'self-hosted'],
      [401, undefined, false, 'unreachable'],
      [404, undefined, false, 'unreachable'],
      [500, undefined, true, 'self-hosted'],
      [502, undefined, false, 'unreachable'],
      [0, undefined, true, 'self-hosted'],
      [0, undefined, false, 'unreachable'],
      // A 200 that names no tenant at all is no answer.
      [200, undefined, true, 'self-hosted'],
      [200, undefined, false, 'unreachable'],
    ];
    for (const [status, tenantId, found, route] of cases) {
      expect(keyRoute({ status, tenantId }, found), `${status} ${tenantId} ${found}`).toBe(route);
    }
  });

  it('counts a store on the relays by its profile name or its inbox list', () => {
    expect(relaysShowAStore({ name: 'Shop', noInboxList: true })).toBe(true);
    expect(relaysShowAStore({ noInboxList: false })).toBe(true);
    expect(relaysShowAStore({ noInboxList: true })).toBe(false);
  });

  it('lets the cloud decide alone only where the relays change nothing', () => {
    expect(cloudDecides({ status: 200, tenantId: 'aaaaaaaaaaaa' })).toBe(true);
    expect(cloudDecides({ status: 403, tenantId: undefined })).toBe(true);
    expect(cloudDecides({ status: 200, tenantId: null })).toBe(false);
    expect(cloudDecides({ status: 0, tenantId: undefined })).toBe(false);
    expect(cloudDecides({ status: 401, tenantId: undefined })).toBe(false);
  });

  it("reads the tenant id from the client's answer only as a string or a null", () => {
    expect(ownerAnswerOf({ status: 200, body: { tenantId: 'x' } })).toEqual({
      status: 200,
      tenantId: 'x',
    });
    expect(ownerAnswerOf({ status: 200, body: { tenantId: null } }).tenantId).toBeNull();
    for (const body of [{ tenantId: 7 }, {}, null, 'text', [{ tenantId: 'x' }]]) {
      expect(ownerAnswerOf({ status: 200, body }).tenantId, JSON.stringify(body)).toBeUndefined();
    }
  });
});
