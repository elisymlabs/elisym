import { finalizeEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { newAskId } from '../src/chat/messages';
import { unwrapChatMessage, wrapChatMessage } from '../src/chat/wrap';
import { buildTicket, checkTicket, clockOffsetFromTicket } from '../src/ticket';
import { NOW, sign, testKey } from './fixtures';

const visitor = testKey();
const assistant = testKey();
const gateway = testKey();
const store = testKey();

function ticket(now = NOW) {
  return sign(buildTicket({ visitor: visitor.pubkey, store: store.pubkey, now }), gateway);
}

function ask() {
  return {
    type: 'ask' as const,
    ask_id: newAskId(),
    text: 'something warm under $80',
    ticket: ticket(),
    page: { url: 'https://shop.example.com/products/x' },
    locale: 'en-US',
  };
}

describe('chat wraps', () => {
  it('round-trips an ask to the assistant and carries an expiration', () => {
    const message = ask();
    const { wrap, rumorId } = wrapChatMessage({
      message,
      senderSecretKey: visitor.secretKey,
      recipientPubkey: assistant.pubkey,
      expiresAt: NOW + 3_600,
      now: NOW,
    });
    expect(wrap.tags).toContainEqual(['expiration', String(NOW + 3_600)]);
    expect(wrap.pubkey).not.toBe(visitor.pubkey);
    const opened = unwrapChatMessage(wrap, assistant.secretKey);
    expect(opened).toMatchObject({
      rumorId,
      senderPubkey: visitor.pubkey,
      recipientPubkey: assistant.pubkey,
      createdAt: NOW,
      expiresAt: NOW + 3_600,
    });
    // Compared as JSON: nostr-tools caches its verify verdict on the ticket under a symbol.
    expect(JSON.parse(JSON.stringify(opened?.message))).toEqual(
      JSON.parse(JSON.stringify(message)),
    );
  });

  it('opens for the recipient only', () => {
    const { wrap } = wrapChatMessage({
      message: ask(),
      senderSecretKey: visitor.secretKey,
      recipientPubkey: assistant.pubkey,
      expiresAt: NOW + 60,
      now: NOW,
    });
    expect(unwrapChatMessage(wrap, testKey().secretKey)).toBeUndefined();
  });

  it('refuses a tampered wrap', () => {
    const { wrap } = wrapChatMessage({
      message: ask(),
      senderSecretKey: visitor.secretKey,
      recipientPubkey: assistant.pubkey,
      expiresAt: NOW + 60,
      now: NOW,
    });
    expect(
      unwrapChatMessage({ ...wrap, content: wrap.content.slice(0, -4) }, assistant.secretKey),
    ).toBeUndefined();
  });

  it('refuses an oversized wrap before decrypting', () => {
    const outsider = testKey();
    const giant = finalizeEvent(
      {
        kind: 1059,
        created_at: NOW,
        tags: [['p', assistant.pubkey]],
        content: 'A'.repeat(80_000),
      },
      outsider.secretKey,
    );
    expect(unwrapChatMessage(giant, assistant.secretKey)).toBeUndefined();
  });

  it('refuses to send a message over the working cap', () => {
    const guide = {
      type: 'guide' as const,
      title: 't',
      // Quotes double under each JSON escaping: the cap is on the serialized rumor.
      sections: Array.from({ length: 6 }, () => ({ heading: 'h', body: '"'.repeat(600) })),
    };
    expect(() =>
      wrapChatMessage({
        message: {
          type: 'answer',
          ask_id: newAskId(),
          session_end: NOW + 100,
          text: 'x',
          components: [guide, guide, guide, guide],
          chips: [],
        },
        senderSecretKey: assistant.secretKey,
        recipientPubkey: visitor.pubkey,
        expiresAt: NOW + 60,
        now: NOW,
      }),
    ).toThrow(/working size cap/);
  });

  it('refuses an expiration in the past', () => {
    expect(() =>
      wrapChatMessage({
        message: ask(),
        senderSecretKey: visitor.secretKey,
        recipientPubkey: assistant.pubkey,
        expiresAt: NOW,
        now: NOW,
      }),
    ).toThrow();
  });
});

describe('tickets', () => {
  const options = { gatewayKeys: [gateway.pubkey], store: store.pubkey, sender: visitor.pubkey };

  it('accepts a fresh ticket for the right visitor and store', () => {
    expect(checkTicket(ticket(), { ...options, now: NOW + 10 })).toBe('valid');
  });

  it('reports expiry separately', () => {
    expect(checkTicket(ticket(), { ...options, now: NOW + 31 * 60 })).toBe('expired');
  });

  it('refuses another sender, another store and an unknown gateway', () => {
    expect(checkTicket(ticket(), { ...options, sender: testKey().pubkey, now: NOW })).toBe(
      'invalid',
    );
    expect(checkTicket(ticket(), { ...options, store: testKey().pubkey, now: NOW })).toBe(
      'invalid',
    );
    expect(checkTicket(ticket(), { ...options, gatewayKeys: [testKey().pubkey], now: NOW })).toBe(
      'invalid',
    );
  });

  it('gives the widget its clock offset', () => {
    expect(clockOffsetFromTicket(ticket(NOW), NOW - 600)).toBe(600);
  });
});
