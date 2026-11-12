import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { poolSyncClient } from '../src/relay/sync-client';
import { FakePool } from './fake-pool';
import { NOW } from './fixtures';

const RELAY = 'wss://relay.test';

describe('the sync client publishes only what the relay accepted (7.1)', () => {
  const event = finalizeEvent(
    { kind: 30402, created_at: NOW, tags: [['d', 'mug']], content: '' },
    generateSecretKey(),
  );

  it('resolves once the relay accepted the event', async () => {
    const pool = new FakePool();
    await poolSyncClient(pool, RELAY).publish([], event);
    expect(pool.relay(RELAY).events.map((stored) => stored.id)).toEqual([event.id]);
  });

  it('throws when the relay cannot be reached, so a sync never counts it as published', async () => {
    const pool = new FakePool();
    pool.unreachable.add(RELAY);
    await expect(poolSyncClient(pool, RELAY).publish([], event)).rejects.toThrow(
      `The relay did not accept ${event.id}`,
    );
  });

  it('throws when the relay refuses the event', async () => {
    const pool = new FakePool();
    const relay = pool.relay(RELAY);
    relay.publish = async () => {
      throw new Error('blocked: not allowed');
    };
    await expect(poolSyncClient(pool, RELAY).publish([], event)).rejects.toThrow(
      'blocked: not allowed',
    );
  });
});
