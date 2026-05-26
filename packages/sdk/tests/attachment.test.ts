import { describe, it, expect } from 'vitest';
import { LIMITS } from '../src/constants';
import {
  encodeJobPayload,
  decodeJobPayload,
  ENVELOPE_VERSION,
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
