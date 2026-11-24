import type { ConfigInput, EvmCredit, Payout, StoreConfig } from './types';

/** What one screen changes; every other field is kept as the last read had it. */
export interface ConfigEdit {
  name?: string;
  /** Empty: none. */
  nip05?: string;
  payouts?: Payout[];
  evmCredit?: EvmCredit;
  inboxRelays?: string[];
  /** Null: no webhook. */
  webhookUrl?: string | null;
}

/**
 * `PUT store/config` replaces the whole config, so it is always built from the
 * last read plus the edit (the webhook URL and the EVM credit survive a
 * payouts save), at the revision that read had: a change made elsewhere since
 * is refused as `stale_config`, never overwritten.
 */
export function fullConfig(config: StoreConfig, edit: ConfigEdit): ConfigInput {
  const nip05 = edit.nip05 ?? config.nip05 ?? '';
  return {
    name: edit.name ?? config.name,
    ...(nip05 === '' ? {} : { nip05 }),
    payouts: edit.payouts ?? config.draftPayouts,
    evmCredit: edit.evmCredit ?? config.evmCredit,
    webhookUrl: edit.webhookUrl === undefined ? (config.webhookUrl ?? null) : edit.webhookUrl,
    inboxRelays: edit.inboxRelays ?? config.inboxRelays,
    expectedRevision: config.revision,
  };
}
