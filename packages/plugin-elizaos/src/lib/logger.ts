import pino from 'pino';

export const logger = pino({
  name: 'elisym-plugin',
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      '*.ELISYM_NOSTR_PRIVATE_KEY',
      '*.ELISYM_SOLANA_PRIVATE_KEY',
      '*.nostrPrivateKeyHex',
      '*.solanaPrivateKeyBase58',
      '*.secretKey',
      '*.secret',
      'ELISYM_NOSTR_PRIVATE_KEY',
      'ELISYM_SOLANA_PRIVATE_KEY',
    ],
    censor: '[REDACTED]',
  },
});
