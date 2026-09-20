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

  it('redacts every key of the secrets file, alone or under another parent', () => {
    // The real pino pipeline, because a path that is in the list and misspelt
    // redacts nothing: the delegate key was absent from the list altogether, so
    // a call site logging it on its own - or an object that carries it - wrote
    // it to stderr in clear. Only the whole `secrets` object was caught.
    const { stream, records } = capture();
    const logger = createLogger(stream);
    logger.error(
      {
        event: 'delegate_setup_failed',
        solana_delegate_secret_key: 'delegate-key-alone',
        agent: { name: 'alice', solana_delegate_secret_key: 'delegate-key-nested' },
      },
      'delegate setup failed',
    );
    const joined = JSON.stringify(records[0]);
    expect(joined).not.toContain('delegate-key-alone');
    expect(joined).not.toContain('delegate-key-nested');
    expect(records[0]?.solana_delegate_secret_key).toBe('[REDACTED]');
    // The neighbour it sits beside is left alone: redaction names fields, it
    // does not blank the object.
    expect((records[0]?.agent as { name?: string } | undefined)?.name).toBe('alice');
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
