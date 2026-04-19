import {
  getProtocolConfig,
  getProtocolProgramId,
  SolanaPaymentStrategy as SolanaPaymentStrategyCtor,
  type ProtocolConfigInput,
  type SolanaPaymentStrategy,
} from '@elisym/sdk';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import type { ElisymNetwork } from '../types';

const paymentStrategy = new SolanaPaymentStrategyCtor();

export function paymentStrategyInstance(): SolanaPaymentStrategy {
  return paymentStrategy;
}

export async function fetchProtocolConfig(
  rpc: Rpc<SolanaRpcApi>,
  network: ElisymNetwork,
): Promise<ProtocolConfigInput> {
  if (network !== 'devnet') {
    throw new Error(
      `Network "${network}" is not supported yet. Only "devnet" is available until the on-chain protocol program is deployed on mainnet.`,
    );
  }
  const programId = getProtocolProgramId(network);
  const config = await getProtocolConfig(rpc, programId);
  return { feeBps: config.feeBps, treasury: config.treasury };
}
