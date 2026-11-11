import type { NostrEvent } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { KIND_CHAT_MESSAGE } from '../src/constants';

/** Knobs to build a deliberately broken gift wrap, one defect at a time. */
export interface CraftOptions {
  content: string;
  sender: Uint8Array;
  recipient: string;
  now: number;
  /** Rumor `pubkey` other than the seal signer's. */
  rumorPubkey?: string;
  /** Rumor `id` other than its hash. */
  rumorId?: string;
  /** A `sig` field on the rumor. */
  rumorSig?: string;
  /** Rumor `p` tag other than the recipient. */
  rumorRecipient?: string;
  /** Tags on the seal (NIP-59 forbids them). */
  sealTags?: string[][];
  /** Break the seal signature after signing. */
  breakSealSig?: boolean;
  /** Break the wrap signature after signing. */
  breakWrapSig?: boolean;
  /** Padding to inflate the rumor content. */
  padRumorTo?: number;
}

function flipLastHex(value: string): string {
  const last = value.slice(-1);
  return value.slice(0, -1) + (last === '0' ? '1' : '0');
}

export function craftWrap(options: CraftOptions): NostrEvent {
  const senderPubkey = getPublicKey(options.sender);
  const rumorPubkey = options.rumorPubkey ?? senderPubkey;
  const content =
    options.padRumorTo === undefined
      ? options.content
      : options.content + ' '.repeat(Math.max(0, options.padRumorTo - options.content.length));
  const fields = {
    pubkey: rumorPubkey,
    created_at: options.now,
    kind: KIND_CHAT_MESSAGE,
    tags: [['p', options.rumorRecipient ?? options.recipient]],
    content,
  };
  const rumor: Record<string, unknown> = { ...fields, id: options.rumorId ?? getEventHash(fields) };
  if (options.rumorSig !== undefined) {
    rumor.sig = options.rumorSig;
  }
  const sealed = finalizeEvent(
    {
      kind: 13,
      created_at: options.now,
      tags: options.sealTags ?? [],
      content: nip44.v2.encrypt(
        JSON.stringify(rumor),
        nip44.v2.utils.getConversationKey(options.sender, options.recipient),
      ),
    },
    options.sender,
  );
  const seal = options.breakSealSig ? { ...sealed, sig: flipLastHex(sealed.sig) } : sealed;
  const ephemeral = generateSecretKey();
  const wrapped = finalizeEvent(
    {
      kind: 1059,
      created_at: options.now,
      tags: [
        ['p', options.recipient],
        ['expiration', String(options.now + 600)],
      ],
      content: nip44.v2.encrypt(
        JSON.stringify(seal),
        nip44.v2.utils.getConversationKey(ephemeral, options.recipient),
      ),
    },
    ephemeral,
  );
  return options.breakWrapSig ? { ...wrapped, sig: flipLastHex(wrapped.sig) } : wrapped;
}
