import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { INPUT_REDACT_PATHS, SECRET_REDACT_PATHS } from '../../src/lib/logger';

interface LogEntry {
  msg: string;
  [key: string]: unknown;
}

function captureLog(): { logger: pino.Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      try {
        const parsed = JSON.parse(chunk.toString()) as LogEntry;
        entries.push(parsed);
      } catch {
        // ignore non-JSON
      }
      callback();
    },
  });
  const logger = pino(
    {
      name: 'test',
      redact: {
        paths: [...SECRET_REDACT_PATHS, ...INPUT_REDACT_PATHS],
        censor: (...args: unknown[]) => {
          const path = args[1] as string[];
          const last = path[path.length - 1];
          if (last === 'content' || last === 'input' || last === 'prompt') {
            return '[INPUT REDACTED]';
          }
          return '[REDACTED]';
        },
      },
    },
    stream,
  );
  return { logger, entries };
}

describe('logger redaction', () => {
  it('redacts top-level secret keys', () => {
    const { logger, entries } = captureLog();
    logger.info({ ELISYM_SOLANA_PRIVATE_KEY: 'leak-me' }, 'test');
    expect(entries[0]?.ELISYM_SOLANA_PRIVATE_KEY).toBe('[REDACTED]');
  });

  it('scrubs job content', () => {
    const { logger, entries } = captureLog();
    logger.info({ content: 'super secret prompt' }, 'incoming job');
    expect(entries[0]?.content).toBe('[INPUT REDACTED]');
  });

  it('scrubs nested input fields', () => {
    const { logger, entries } = captureLog();
    logger.info({ event: { id: 'abc', content: 'hi' }, input: 'do thing' }, 'log');
    const event = entries[0]?.event as { id?: string; content?: string };
    expect(event?.id).toBe('abc');
    expect(event?.content).toBe('[INPUT REDACTED]');
    expect(entries[0]?.input).toBe('[INPUT REDACTED]');
  });

  it('scrubs prompt fields', () => {
    const { logger, entries } = captureLog();
    logger.info({ prompt: 'You are X. Task: Y.' }, 'llm call');
    expect(entries[0]?.prompt).toBe('[INPUT REDACTED]');
  });

  it('passes through non-sensitive context unchanged', () => {
    const { logger, entries } = captureLog();
    logger.info({ jobId: 'job-1', count: 5 }, 'ok');
    expect(entries[0]?.jobId).toBe('job-1');
    expect(entries[0]?.count).toBe(5);
  });
});
