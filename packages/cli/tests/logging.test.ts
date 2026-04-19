import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logging';

interface LogEntry {
  msg?: string;
  level?: number;
  [key: string]: unknown;
}

function captureStream(): { stream: Writable; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      try {
        entries.push(JSON.parse(chunk.toString()) as LogEntry);
      } catch {
        // ignore non-JSON
      }
      callback();
    },
  });
  return { stream, entries };
}

describe('createLogger', () => {
  it('redacts secret-path keys', () => {
    const { stream, entries } = captureStream();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.info({ ELISYM_SOLANA_PRIVATE_KEY: 'leak' }, 'startup');
    expect(entries[0]?.ELISYM_SOLANA_PRIVATE_KEY).toBe('[REDACTED]');
  });

  it('redacts input-path keys as [INPUT REDACTED]', () => {
    const { stream, entries } = captureStream();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.info({ content: 'customer prompt', jobId: 'j1' }, 'incoming');
    expect(entries[0]?.content).toBe('[INPUT REDACTED]');
    expect(entries[0]?.jobId).toBe('j1');
  });

  it('enables debug level when verbose is set', () => {
    const { stream, entries } = captureStream();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.debug({ event: 'relay_open', url: 'wss://x' }, 'relay open');
    expect(entries[0]?.event).toBe('relay_open');
  });

  it('suppresses debug messages at default level', () => {
    const { stream, entries } = captureStream();
    const { logger } = createLogger({ destination: stream });
    logger.debug({ event: 'noise' }, 'should drop');
    expect(entries).toHaveLength(0);
  });

  it('explicit level overrides verbose', () => {
    const { stream, entries } = captureStream();
    const { logger } = createLogger({ destination: stream, verbose: true, level: 'warn' });
    logger.info({ x: 1 }, 'info drops');
    logger.warn({ x: 1 }, 'warn lands');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toBe('warn lands');
  });

  it('redacts nested event.content but keeps event.id', () => {
    const { stream, entries } = captureStream();
    const { logger } = createLogger({ destination: stream, verbose: true });
    logger.info({ event: { id: 'abc', content: 'secret body' } }, 'ingest');
    const event = entries[0]?.event as { id?: string; content?: string };
    expect(event?.id).toBe('abc');
    expect(event?.content).toBe('[INPUT REDACTED]');
  });
});
