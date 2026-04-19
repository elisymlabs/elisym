import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging';

/**
 * Regression fence around B.4's invariant: any callsite that accidentally
 * passes user input through the pino logger (via `content`, `input`,
 * `prompt`, `event.content`) must be redacted before the bytes land on
 * stderr, regardless of whether verbose mode is on.
 */
function capture(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe('cli log scrubbing', () => {
  it('redacts raw job input regardless of verbose', () => {
    const { stream, lines } = capture();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.info(
      {
        event: 'job_received',
        jobId: 'j1',
        capability: 'summarize',
        content: 'this is customer-private content',
      },
      'job received',
    );
    const joined = lines.join('\n');
    expect(joined).not.toContain('customer-private');
    expect(joined).toContain('[INPUT REDACTED]');
  });

  it('redacts nested event.content inside a raw-event diagnostic', () => {
    const { stream, lines } = capture();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.debug(
      { event: { id: 'abc', content: 'inner secret' }, eventId: 'abc' },
      'firehose ingest',
    );
    const joined = lines.join('\n');
    expect(joined).not.toContain('inner secret');
    expect(joined).toContain('[INPUT REDACTED]');
  });

  it('redacts ELISYM_* secret env vars that may flow into a config-resolution debug log', () => {
    const { stream, lines } = capture();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.debug(
      {
        event: 'config_resolved',
        ELISYM_SOLANA_PRIVATE_KEY: 'absolutelynoleak',
      },
      'config',
    );
    const joined = lines.join('\n');
    expect(joined).not.toContain('absolutelynoleak');
    expect(joined).toContain('[REDACTED]');
  });
});
