import { type Address, getProgramDerivedAddress } from '@solana/kit';

export const CONFIG_SEED = 'config';

export const MAX_FEE_BPS = 1000;

export async function deriveConfigAddress(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode(CONFIG_SEED)],
  });
  return pda;
}
