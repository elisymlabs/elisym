import { type Address, getProgramDerivedAddress } from '@solana/kit';

export const CONFIG_SEED = 'config';
export const STATS_SEED = 'network_stats';
export const EVENT_AUTHORITY_SEED = '__event_authority';

export const MAX_FEE_BPS = 1000;

export async function deriveConfigAddress(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(CONFIG_SEED)],
  });
  return pda;
}

export async function deriveNetworkStatsAddress(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(STATS_SEED)],
  });
  return pda;
}

/**
 * Derives the Anchor `event_authority` PDA used by `emit_cpi!()` instructions.
 * Required as a read-only account for any instruction declared with `#[event_cpi]`.
 */
export async function deriveEventAuthorityAddress(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(EVENT_AUTHORITY_SEED)],
  });
  return pda;
}
