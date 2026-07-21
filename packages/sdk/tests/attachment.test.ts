import { describe, it, expect } from 'vitest';
import { LIMITS } from '../src/constants';
import {
  encodeJobPayload,
  decodeJobPayload,
  attachmentsOf,
  ENVELOPE_VERSION,
  ACCEPT_TRANSPORTS_TAG,
  SESSION_ID_REGEX,
  buildAcceptTransportsTag,
  readAcceptedTransports,
  type FileAttachment,
} from '../src/transport/attachment';

const attachment: FileAttachment = {
  name: 'data.bin',
  size: 1234,
  mime: 'application/octet-stream',
  transports: [{ kind: 'iroh', ticket: 'blobaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
};

describe('encodeJobPayload / decodeJobPayload', () => {
  it('round-trips a text-only payload', () => {
    const encoded = encodeJobPayload({ text: 'hello world' });
    const decoded = decodeJobPayload(encoded);
    expect(decoded.text).toBe('hello world');
    expect(decoded.attachment).toBeUndefined();
  });

  it('round-trips an attachment-only payload', () => {
    const encoded = encodeJobPayload({ attachment });
    const decoded = decodeJobPayload(encoded);
    expect(decoded.text).toBeUndefined();
    expect(decoded.attachment).toEqual(attachment);
  });

  it('round-trips text + attachment', () => {
    const encoded = encodeJobPayload({ text: 'please review', attachment });
    const decoded = decodeJobPayload(encoded);
    expect(decoded.text).toBe('please review');
    expect(decoded.attachment).toEqual(attachment);
  });

  it('preserves the optional seedingExpiresAt hint', () => {
    const withExpiry: FileAttachment = { ...attachment, seedingExpiresAt: 1_900_000_000 };
    const decoded = decodeJobPayload(encodeJobPayload({ attachment: withExpiry }));
    expect(decoded.attachment?.seedingExpiresAt).toBe(1_900_000_000);
  });

  it('stamps the current envelope version', () => {
    const encoded = encodeJobPayload({ attachment });
    expect(JSON.parse(encoded).v).toBe(ENVELOPE_VERSION);
  });
});

describe('decodeJobPayload - raw text (back-compat)', () => {
  it('treats plain text as a text payload', () => {
    expect(decodeJobPayload('just some text')).toEqual({ text: 'just some text' });
  });

  it('treats non-object JSON (array) as raw text', () => {
    expect(decodeJobPayload('[1,2,3]')).toEqual({ text: '[1,2,3]' });
  });

  it('treats non-object JSON (number) as raw text', () => {
    expect(decodeJobPayload('42')).toEqual({ text: '42' });
  });

  it('treats a JSON object without our namespace marker as raw text', () => {
    const raw = JSON.stringify({ answer: 'hi', v: '1.0' });
    expect(decodeJobPayload(raw)).toEqual({ text: raw });
  });

  it('does not parse content longer than MAX_INPUT_LENGTH (returns raw text)', () => {
    const huge = 'x'.repeat(LIMITS.MAX_INPUT_LENGTH + 1);
    expect(decodeJobPayload(huge)).toEqual({ text: huge });
  });
});

describe('decodeJobPayload - rejects malformed envelopes', () => {
  it('throws on an unknown envelope version', () => {
    const future = JSON.stringify({ v: 'elisym-job/2', text: 'x' });
    expect(() => decodeJobPayload(future)).toThrow(/elisym-job\/2/);
  });

  it('throws on a marker payload with a malformed attachment (no transports)', () => {
    const bad = JSON.stringify({
      v: ENVELOPE_VERSION,
      attachment: { ...attachment, transports: [] },
    });
    expect(() => decodeJobPayload(bad)).toThrow();
  });

  it('throws on a marker payload with an unknown transport kind', () => {
    const bad = JSON.stringify({
      v: ENVELOPE_VERSION,
      attachment: { ...attachment, transports: [{ kind: 'carrier-pigeon', ref: 'x' }] },
    });
    expect(() => decodeJobPayload(bad)).toThrow();
  });

  it('throws on a marker payload with an over-long ticket', () => {
    const bad = JSON.stringify({
      v: ENVELOPE_VERSION,
      attachment: { ...attachment, transports: [{ kind: 'iroh', ticket: 'a'.repeat(5000) }] },
    });
    expect(() => decodeJobPayload(bad)).toThrow();
  });
});

describe('decodeJobPayload - blossom transport + lenient transports', () => {
  const blossomTransport = {
    kind: 'blossom' as const,
    url: `https://files.elisym.network/${'a'.repeat(64)}.bin`,
    sha256: 'a'.repeat(64),
    enc: { alg: 'AES-256-GCM' as const, iv: 'AAAAAAAAAAAAAAAAAAAAAA==', key: 'wrapped-key-b64' },
  };

  it('round-trips a blossom attachment', () => {
    const blossomAttachment: FileAttachment = {
      name: 'secret.png',
      size: 1234,
      mime: 'image/png',
      transports: [blossomTransport],
    };
    const decoded = decodeJobPayload(encodeJobPayload({ attachment: blossomAttachment }));
    expect(decoded.attachment).toEqual(blossomAttachment);
  });

  it('drops unknown transport kinds but keeps a known one (no throw)', () => {
    const raw = JSON.stringify({
      v: ENVELOPE_VERSION,
      attachment: {
        ...attachment,
        transports: [
          { kind: 'carrier-pigeon', ref: 'x' },
          { kind: 'iroh', ticket: 'blobaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        ],
      },
    });
    const decoded = decodeJobPayload(raw);
    expect(decoded.attachment?.transports).toEqual([
      { kind: 'iroh', ticket: 'blobaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    ]);
  });

  it('preserves the order of known transports (blossom before iroh)', () => {
    const both: FileAttachment = {
      ...attachment,
      transports: [blossomTransport, { kind: 'iroh', ticket: 'blobaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
    };
    const decoded = decodeJobPayload(encodeJobPayload({ attachment: both }));
    expect(decoded.attachment?.transports.map((t) => t.kind)).toEqual(['blossom', 'iroh']);
  });
});

describe('accept-transports tag (buildAcceptTransportsTag / readAcceptedTransports)', () => {
  it('round-trips a built tag', () => {
    const tag = buildAcceptTransportsTag(['blossom', 'iroh']);
    expect(tag).toEqual([ACCEPT_TRANSPORTS_TAG, 'blossom', 'iroh']);
    expect(readAcceptedTransports([tag])).toEqual(['blossom', 'iroh']);
  });

  it('dedupes preserving order', () => {
    expect(readAcceptedTransports([['accept', 'iroh', 'iroh', 'blossom']])).toEqual([
      'iroh',
      'blossom',
    ]);
  });

  it('drops unknown kinds but keeps known ones', () => {
    expect(readAcceptedTransports([['accept', 'carrier-pigeon', 'iroh']])).toEqual(['iroh']);
  });

  it('returns undefined when there is no accept tag', () => {
    expect(
      readAcceptedTransports([
        ['t', 'elisym'],
        ['p', 'abc'],
      ]),
    ).toBeUndefined();
  });

  it('returns undefined when the accept tag has no known kind (forward-compat default)', () => {
    expect(readAcceptedTransports([['accept', 'carrier-pigeon']])).toBeUndefined();
  });
});

describe('multi-attachment envelope (attachments[] + attachmentsOf)', () => {
  const a1: FileAttachment = {
    name: 'vocals.wav',
    size: 100,
    mime: 'audio/wav',
    transports: [{ kind: 'iroh', ticket: 'blobaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
  };
  const a2: FileAttachment = {
    name: 'drums.wav',
    size: 200,
    mime: 'audio/wav',
    transports: [{ kind: 'iroh', ticket: 'blobbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
  };

  it('round-trips multiple attachments and decodes them as an array', () => {
    const decoded = decodeJobPayload(encodeJobPayload({ text: 'note', attachments: [a1, a2] }));
    expect(decoded.text).toBe('note');
    expect(decoded.attachments).toEqual([a1, a2]);
    expect(attachmentsOf(decoded)).toEqual([a1, a2]);
  });

  it('mirrors `attachment = attachments[0]` so an attachments-unaware decoder gets the first file', () => {
    const parsed = JSON.parse(encodeJobPayload({ attachments: [a1, a2] })) as {
      attachment?: unknown;
      attachments?: unknown[];
    };
    expect(parsed.attachment).toEqual(a1);
    expect(parsed.attachments).toHaveLength(2);
  });

  it('attachmentsOf normalizes a legacy single attachment to a 1-element list', () => {
    const decoded = decodeJobPayload(encodeJobPayload({ attachment: a1 }));
    expect(attachmentsOf(decoded)).toEqual([a1]);
  });

  it('attachmentsOf returns [] for a text-only payload', () => {
    expect(attachmentsOf({ text: 'hi' })).toEqual([]);
    expect(attachmentsOf(decodeJobPayload('plain text'))).toEqual([]);
  });
});

describe('session ref in the envelope', () => {
  const SESSION_ID = '3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c';

  it('round-trips a session-only payload (text + session, no attachment)', () => {
    const decoded = decodeJobPayload(
      encodeJobPayload({ text: 'turn 2', session: { id: SESSION_ID } }),
    );
    expect(decoded.text).toBe('turn 2');
    expect(decoded.session).toEqual({ id: SESSION_ID });
    expect(decoded.attachment).toBeUndefined();
  });

  it('round-trips session + attachment together', () => {
    const decoded = decodeJobPayload(
      encodeJobPayload({ text: 'note', attachment, session: { id: SESSION_ID } }),
    );
    expect(decoded.session).toEqual({ id: SESSION_ID });
    expect(decoded.attachment).toEqual(attachment);
  });

  it('omits the session key entirely when not provided', () => {
    const parsed = JSON.parse(encodeJobPayload({ text: 'hi' })) as Record<string, unknown>;
    expect('session' in parsed).toBe(false);
  });

  it('decodes an invalid session shape as absent instead of throwing (lenient)', () => {
    const cases: unknown[] = [
      { id: 'not-a-uuid' },
      { id: SESSION_ID.toUpperCase() },
      { id: '../../etc/passwd' },
      { id: 42 },
      'bare-string',
      { nested: { id: SESSION_ID } },
    ];
    for (const session of cases) {
      const raw = JSON.stringify({ v: ENVELOPE_VERSION, text: 'x', session });
      const decoded = decodeJobPayload(raw);
      expect(decoded.session, JSON.stringify(session)).toBeUndefined();
      expect(decoded.text).toBe('x');
    }
  });

  it('rejects a non-v4 or wrong-variant UUID', () => {
    expect(SESSION_ID_REGEX.test('3f2b8c1a-9d4e-1f6a-8b2c-1d3e5f7a9b0c')).toBe(false);
    expect(SESSION_ID_REGEX.test('3f2b8c1a-9d4e-4f6a-cb2c-1d3e5f7a9b0c')).toBe(false);
    expect(SESSION_ID_REGEX.test(SESSION_ID)).toBe(true);
  });

  it('an old decoder shape (unknown keys stripped) still parses text and attachment', () => {
    // Simulates the reverse direction: a NEWER envelope with extra keys decodes
    // fine because the schema strips unknown keys instead of rejecting.
    const raw = JSON.stringify({
      v: ENVELOPE_VERSION,
      text: 'hello',
      session: { id: SESSION_ID },
      some_future_key: { a: 1 },
    });
    const decoded = decodeJobPayload(raw);
    expect(decoded.text).toBe('hello');
    expect(decoded.session).toEqual({ id: SESSION_ID });
  });
});
