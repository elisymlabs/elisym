import { describe, expect, it } from 'vitest';
import { createSessionDeps } from '../src/lib/deps';

describe('createSessionDeps', () => {
  it('reads time in seconds, through a client and a pool that share no connection', () => {
    const deps = createSessionDeps();
    expect(Math.abs(deps.now() - Date.now() / 1000)).toBeLessThan(2);
    expect(deps.client).not.toBe(deps.pool);
    deps.client.close();
  });
});
