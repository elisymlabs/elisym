import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';

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

describe('mcp logger', () => {
  it('redacts secret-path keys', () => {
    const { stream, records } = capture();
    const logger = createLogger(stream);
    logger.error(
      { event: 'tool_error', ELISYM_NOSTR_PRIVATE_KEY: 'absolutely-not-leaking' },
      'tool failed',
    );
    const joined = JSON.stringify(records[0]);
    expect(joined).not.toContain('absolutely-not-leaking');
    expect(records[0]?.ELISYM_NOSTR_PRIVATE_KEY).toBe('[REDACTED]');
  });

  it('redacts input-path keys even when embedded in an error payload', () => {
    const { stream, records } = capture();
    const logger = createLogger(stream);
    logger.error(
      {
        event: 'nostr_confirmation_failed',
        jobId: 'j1',
        content: 'customer-private body',
        err: 'verify failed',
      },
      'ack failed',
    );
    const joined = JSON.stringify(records[0]);
    expect(joined).not.toContain('customer-private');
    expect(records[0]?.content).toBe('[INPUT REDACTED]');
    expect(records[0]?.jobId).toBe('j1');
  });

  it('preserves non-sensitive structured context', () => {
    const { stream, records } = capture();
    const logger = createLogger(stream);
    logger.info({ event: 'shutdown', reason: 'SIGINT' }, 'shutting down');
    expect(records[0]?.event).toBe('shutdown');
    expect(records[0]?.reason).toBe('SIGINT');
  });
});
