import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging';

/**
 * These tests assert the structural invariants of the debug firehose
 * emitted when `--verbose` is on: a subset of events - config_resolved,
 * publish_ack, publish_failed, pool_reset - MUST land on
 * the pino stream with a `{ event, ... }` shape, and MUST never carry a
 * secret-path or input-path field verbatim.
 */
function capture(): { stream: Writable; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      try {
        records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      } catch {
        // ignore non-JSON
      }
      cb();
    },
  });
  return { stream, records };
}

describe('verbose debug events', () => {
  it('emits config_resolved at debug with expected keys and no secrets', () => {
    const { stream, records } = capture();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.debug(
      {
        event: 'config_resolved',
        agent: 'my-agent',
        network: 'devnet',
        relays: ['wss://r1', 'wss://r2'],
        solanaAddress: 'PubKey111',
        ELISYM_SOLANA_PRIVATE_KEY: 'leak-me',
      },
      'config resolved',
    );
    const entry = records.find((r) => r.event === 'config_resolved');
    expect(entry).toBeDefined();
    expect(entry?.agent).toBe('my-agent');
    expect(entry?.network).toBe('devnet');
    expect(entry?.ELISYM_SOLANA_PRIVATE_KEY).toBe('[REDACTED]');
    expect(JSON.stringify(entry)).not.toContain('leak-me');
  });

  it('emits publish_ack for profile and capability cards', () => {
    const { stream, records } = capture();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.debug({ event: 'publish_ack', kind: 0 }, 'profile published');
    logger.debug(
      { event: 'publish_ack', kind: 31990, skill: 'summary' },
      'capability card published',
    );
    const acks = records.filter((r) => r.event === 'publish_ack');
    expect(acks).toHaveLength(2);
    expect(acks.find((r) => r.kind === 0)).toBeDefined();
    expect(acks.find((r) => r.skill === 'summary')).toBeDefined();
  });

  it('emits pool_reset with reason on watchdog decision', () => {
    const { stream, records } = capture();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.info({ event: 'pool_reset', reason: 'probe_failed' }, 'pool reset');
    const entry = records.find((r) => r.event === 'pool_reset');
    expect(entry?.reason).toBe('probe_failed');
  });

  it('suppresses debug events when verbose is off', () => {
    const { stream, records } = capture();
    const { logger } = createLogger({ destination: stream });
    logger.debug({ event: 'publish_ack', kind: 0 }, 'drops');
    expect(records.filter((r) => r.event === 'publish_ack')).toHaveLength(0);
  });
});
