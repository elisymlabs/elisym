import { type Address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

export const CONFIG_SEED = 'config';
export const STATS_SEED = 'network_stats';
export const ASSET_STATS_SEED = 'asset_stats';
export const EVENT_AUTHORITY_SEED = '__event_authority';

export const MAX_FEE_BPS = 1000;

/**
 * Mint key used for native SOL in `AssetStats` PDAs. The all-zero pubkey is
 * the System Program's address and can never be a token mint. Declared as a
 * cast, not `address(...)`, so importing this module stays side-effect-free
 * (downstream tests partially mock `@solana/kit`).
 */
export const NATIVE_ASSET_SENTINEL = '11111111111111111111111111111111' as Address;

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
 * Derives the per-mint `AssetStats` PDA. Pass `NATIVE_ASSET_SENTINEL` as the
 * mint for native SOL.
 */
export async function deriveAssetStatsAddress(programId: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(ASSET_STATS_SEED), getAddressEncoder().encode(mint)],
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
