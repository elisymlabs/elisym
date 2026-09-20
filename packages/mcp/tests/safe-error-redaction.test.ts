/**
 * Every error the MCP server hands back has to lose its key material first.
 *
 * `safeError` is the one funnel: every tool handler routes its throws through
 * it, and what comes out goes into the model's context and into the operator's
 * stderr. pino's `redact` paths censor named FIELDS, and an error message is
 * free text, so the scrubbing here is the only thing between a secrets file
 * that failed to parse - or an RPC error echoing a decoded keypair - and a
 * transcript.
 *
 * None of it was measured. Each of the five shapes could be deleted one at a
 * time and the whole package stayed green, and so could the ORDER the comment
 * beside the length cut argues for.
 *
 * Lives in its own file because it mocks `./logger.js`: half of what this
 * function scrubs never reaches the return value at all, and the only way to
 * see it is to watch what was logged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const errorCalls: { err?: string; stack?: string }[] = [];

vi.mock('../src/logger.js', () => ({
  logger: {
    error: (fields: { err?: string; stack?: string }) => {
      errorCalls.push(fields);
    },
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
  },
}));

const { safeError } = await import('../src/server.js');

/** What the model is shown. */
function shown(error: unknown): string {
  const result = safeError('test', error);
  const first = result.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
}

const NSEC = `nsec1${'q'.repeat(58)}`;
const HEX_KEY = 'a1b2c3d4'.repeat(8);
const BASE58_SECRET = '5'.repeat(88);
const PUBLIC_ADDRESS = 'GY7vnWMkKpftU4nQ16C2ATkj1JwrQpHhknkaBUn67VTy';
const RAW_BYTES = `[${Array.from({ length: 64 }, (_unused, index) => index % 256).join(',')}]`;

beforeEach(() => {
  errorCalls.length = 0;
});

describe('an error carrying key material', () => {
  it.each([
    ['a nostr secret key', `failed to parse: ${NSEC}`, NSEC],
    ['an API key', 'auth failed for sk-ant-api03-AAAAAAAAAAAAAAAAAAAA', 'sk-ant-'],
    ['a 64-character hex key', `bad seed ${HEX_KEY}`, HEX_KEY],
    ['a base58 secret key', `signer rejected ${BASE58_SECRET}`, BASE58_SECRET],
    ['a keypair serialized as raw bytes', `JSON.parse failed near ${RAW_BYTES}`, '12,13,14'],
  ])('never shows the model %s', (_label, message, secret) => {
    const text = shown(new Error(message));

    expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
  });

  it('leaves a PUBLIC address alone', () => {
    // The other direction, and the reason these are five narrow shapes rather
    // than one wide one: an address is the single most useful thing an error
    // about a payment can name, and 32-44 base58 is exactly what a public key
    // looks like.
    const text = shown(new Error(`recipient ${PUBLIC_ADDRESS} has no token account`));

    expect(text).toContain(PUBLIC_ADDRESS);
  });

  it('redacts BEFORE the length cut, not after', () => {
    // The ordering the comment beside the cut argues for, and it is worth a row
    // because reversing it looks harmless - the key still gets scrubbed, just
    // one step later. What breaks is that cutting first SPLITS the key, and the
    // 19 characters left of it no longer match a rule that wants 64, so the
    // fragment survives every later pass and lands in the transcript.
    //
    // The filler alternates in a character the base58 rule cannot take, so it
    // is inert: a run of 280 `x` is itself long-enough base58, gets redacted,
    // and the message never reaches the length cut this row is about.
    const filler = 'x0'.repeat(140);
    const text = shown(new Error(`${filler} ${HEX_KEY}`));

    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(HEX_KEY.slice(0, 16));
  });

  it('scrubs the stderr line as well, where pino cannot', () => {
    // Not the same string the model gets: the operator gets the message AND
    // the stack, and a stack is where a key passed as an argument tends to
    // show up. `redact` paths do not scan free text, which is why this is done
    // by hand.
    const error = new Error(`boom ${HEX_KEY}`);
    error.stack = `Error: boom ${HEX_KEY}\n    at signer (${NSEC})`;

    safeError('test', error);

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]?.err).not.toContain(HEX_KEY);
    expect(errorCalls[0]?.stack).not.toContain(HEX_KEY);
    expect(errorCalls[0]?.stack).not.toContain(NSEC);
  });

  it('scrubs a validation error, which is built from issues and not from the message', () => {
    // `ZodError` takes its own branch: the text is assembled out of issue paths
    // and issue messages, so it never passes the redaction the `Error` branch
    // does. The scrub on the way out is the only one it gets, and a refinement
    // message is free text an integrator writes.
    const schema = z.object({
      secret: z.string().refine(() => false, { message: `must not be ${HEX_KEY}` }),
    });
    const parsed = schema.safeParse({ secret: 'anything' });

    const text = shown(parsed.success ? new Error('unreachable') : parsed.error);

    expect(text).toContain('Invalid arguments');
    expect(text).not.toContain(HEX_KEY);
  });
});
