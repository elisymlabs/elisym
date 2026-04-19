import pino from 'pino';

export const SECRET_REDACT_PATHS = [
  '*.ELISYM_NOSTR_PRIVATE_KEY',
  '*.ELISYM_SOLANA_PRIVATE_KEY',
  '*.nostrPrivateKeyHex',
  '*.solanaPrivateKeyBase58',
  '*.secretKey',
  '*.secret',
  'ELISYM_NOSTR_PRIVATE_KEY',
  'ELISYM_SOLANA_PRIVATE_KEY',
];

// Customer-confidential text - LLM prompts, raw event content, job
// inputs. Pino allows two censor strings on a single transport via
// branches: we keep one custom branch by combining everything under a
// single censor, then post-rewrite the prompt/input/content fields if
// they survive.
export const INPUT_REDACT_PATHS = [
  'content',
  'input',
  'prompt',
  '*.content',
  '*.input',
  '*.prompt',
  'event.content',
  '*.event.content',
];

export const logger = pino({
  name: 'elisym-plugin',
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [...SECRET_REDACT_PATHS, ...INPUT_REDACT_PATHS],
    censor: (_value, path) => {
      const last = path[path.length - 1];
      if (last === 'content' || last === 'input' || last === 'prompt') {
        return '[INPUT REDACTED]';
      }
      return '[REDACTED]';
    },
  },
});
