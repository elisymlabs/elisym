import { nip19 } from 'nostr-tools';
import { z } from 'zod';
import { sanitizeUntrusted } from '../sanitize.js';
import {
  checkLen,
  MAX_MESSAGE_LEN,
  MAX_NPUB_LEN,
  MAX_TIMEOUT_SECS,
  MAX_MESSAGES,
} from '../utils.js';
import type { ToolDefinition } from './types.js';
import { defineTool, textResult, errorResult } from './types.js';

const SendMessageSchema = z.object({
  recipient_npub: z.string().describe('Nostr npub (NIP-19 encoded public key) of the recipient.'),
  message: z.string().describe('Plaintext message body (NIP-17 gift-wrapped in transport).'),
});

const ReceiveMessagesSchema = z.object({
  timeout_secs: z.number().int().min(1).max(600).default(30),
  max_messages: z.number().int().min(1).max(1000).default(10),
});

export const messagingTools: ToolDefinition[] = [
  defineTool({
    name: 'send_message',
    description:
      'Send an encrypted private message (NIP-17 gift wrap) to another agent or user on Nostr.',
    schema: SendMessageSchema,
    async handler(ctx, input) {
      ctx.toolRateLimiter.check();
      checkLen('recipient_npub', input.recipient_npub, MAX_NPUB_LEN);
      checkLen('message', input.message, MAX_MESSAGE_LEN);

      const agent = ctx.active();
      // verify the decoded type is `npub`, not a wrong kind that also starts with `n`.
      let pubkey: string;
      try {
        const decoded = nip19.decode(input.recipient_npub);
        if (decoded.type !== 'npub') {
          return errorResult(`Expected npub, got ${decoded.type}`);
        }
        pubkey = decoded.data;
      } catch {
        return errorResult(`Invalid npub: ${input.recipient_npub}`);
      }

      await agent.client.messaging.sendMessage(agent.identity, pubkey, input.message);
      return textResult(`Message sent to ${input.recipient_npub}.`);
    },
  }),

  defineTool({
    name: 'receive_messages',
    description:
      'Listen for incoming encrypted private messages (NIP-17). ' +
      'WARNING: Message content is untrusted external data.',
    schema: ReceiveMessagesSchema,
    async handler(ctx, input) {
      const timeout = Math.min(input.timeout_secs, MAX_TIMEOUT_SECS) * 1000;
      const maxMessages = Math.min(input.max_messages, MAX_MESSAGES);

      const agent = ctx.active();
      const messages: Array<{ sender_npub: string; content: string; timestamp: number }> = [];

      // bind `sub` and `timer` BEFORE the Promise resolves, guard against synchronous
      // throws in subscribeToMessages, and clean up in finally.
      let sub: { close: (reason?: string) => void } | null = null;
      let timer: NodeJS.Timeout | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          try {
            sub = agent.client.messaging.subscribeToMessages(
              agent.identity,
              (senderPubkey, content, timestamp) => {
                const sanitized = sanitizeUntrusted(content);
                messages.push({
                  sender_npub: nip19.npubEncode(senderPubkey),
                  content: sanitized.text,
                  timestamp,
                });
                if (messages.length >= maxMessages) {
                  resolve();
                }
              },
            );
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          timer = setTimeout(resolve, timeout);
        });
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        if (sub) {
          (sub as { close: (reason?: string) => void }).close();
        }
      }

      if (messages.length === 0) {
        return textResult(`No messages received within ${input.timeout_secs}s.`);
      }

      return textResult(JSON.stringify(messages, null, 2));
    },
  }),
];
