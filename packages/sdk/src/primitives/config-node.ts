/**
 * Node.js-only config parsing with secret decryption.
 * Exported from '@elisym/sdk/node'.
 */

import type { AgentConfig } from '../types';
import { isEncrypted, decryptSecret } from './encryption';

/**
 * Parse a JSON string into an AgentConfig.
 * If passphrase is provided, decrypts all encrypted fields (requires Node.js/Bun).
 * If passphrase is not provided and encrypted fields exist, throws.
 */
export function parseConfig(json: string, passphrase?: string): AgentConfig {
  const config = JSON.parse(json) as AgentConfig;

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid config: expected JSON object.');
  }
  if (!config.identity?.secret_key || typeof config.identity.secret_key !== 'string') {
    throw new Error('Invalid config: missing or non-string identity.secret_key.');
  }
  if (typeof config.identity.name !== 'string' || !config.identity.name) {
    throw new Error('Invalid config: missing or non-string identity.name.');
  }
  if (
    !Array.isArray(config.relays) ||
    !config.relays.every((r: unknown) => typeof r === 'string')
  ) {
    throw new Error('Invalid config: relays must be an array of strings.');
  }

  if (config.capabilities !== undefined) {
    if (!Array.isArray(config.capabilities)) {
      throw new Error('Invalid config: capabilities must be an array.');
    }
    for (const cap of config.capabilities) {
      if (
        !cap ||
        typeof cap !== 'object' ||
        typeof cap.name !== 'string' ||
        typeof cap.description !== 'string' ||
        typeof cap.price !== 'number'
      ) {
        throw new Error(
          'Invalid config: each capability must have name (string), description (string), and price (number).',
        );
      }
      if (!Array.isArray(cap.tags) || !cap.tags.every((t: unknown) => typeof t === 'string')) {
        throw new Error('Invalid config: each capability must have tags (array of strings).');
      }
      if (!Number.isInteger(cap.price) || cap.price < 0) {
        throw new Error(
          'Invalid config: capability price must be a non-negative integer (lamports).',
        );
      }
    }
  }
  if (config.payments !== undefined) {
    if (!Array.isArray(config.payments)) {
      throw new Error('Invalid config: payments must be an array.');
    }
    for (const p of config.payments) {
      if (
        !p ||
        typeof p !== 'object' ||
        typeof p.chain !== 'string' ||
        typeof p.network !== 'string' ||
        typeof p.address !== 'string'
      ) {
        throw new Error(
          'Invalid config: each payment entry must have chain, network, and address (all strings).',
        );
      }
    }
  }
  if (config.wallet !== undefined) {
    if (
      !config.wallet ||
      typeof config.wallet !== 'object' ||
      typeof config.wallet.chain !== 'string' ||
      typeof config.wallet.network !== 'string' ||
      typeof config.wallet.secret_key !== 'string'
    ) {
      throw new Error(
        'Invalid config: wallet must have chain, network, and secret_key (all strings).',
      );
    }
  }
  if (config.llm !== undefined) {
    if (
      !config.llm ||
      typeof config.llm !== 'object' ||
      typeof config.llm.provider !== 'string' ||
      typeof config.llm.model !== 'string' ||
      typeof config.llm.api_key !== 'string' ||
      typeof config.llm.max_tokens !== 'number' ||
      !Number.isInteger(config.llm.max_tokens) ||
      config.llm.max_tokens <= 0
    ) {
      throw new Error(
        'Invalid config: llm must have provider, model, api_key (strings) and max_tokens (positive integer).',
      );
    }
  }

  if (!passphrase) {
    const encrypted: string[] = [];
    if (config.identity?.secret_key && isEncrypted(config.identity.secret_key)) {
      encrypted.push('identity.secret_key');
    }
    if (config.wallet?.secret_key && isEncrypted(config.wallet.secret_key)) {
      encrypted.push('wallet.secret_key');
    }
    if (config.llm?.api_key && isEncrypted(config.llm.api_key)) {
      encrypted.push('llm.api_key');
    }
    if (encrypted.length > 0) {
      throw new Error(
        `Fields [${encrypted.join(', ')}] are encrypted but no passphrase provided. Set ELISYM_PASSPHRASE env var.`,
      );
    }
    return config;
  }

  if (config.identity?.secret_key && isEncrypted(config.identity.secret_key)) {
    config.identity.secret_key = decryptSecret(config.identity.secret_key, passphrase);
  }
  if (config.wallet?.secret_key && isEncrypted(config.wallet.secret_key)) {
    config.wallet.secret_key = decryptSecret(config.wallet.secret_key, passphrase);
  }
  if (config.llm?.api_key && isEncrypted(config.llm.api_key)) {
    config.llm.api_key = decryptSecret(config.llm.api_key, passphrase);
  }

  return config;
}
