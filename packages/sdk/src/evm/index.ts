/**
 * `@elisym/sdk/evm` - the EVM payment rail.
 *
 * What lives here needs an rpc; the shape checks and the registry that need
 * none are in the root entry (`payment/chains`). The rpc is an EIP-1193
 * `request`, so reading and verifying pull in no EVM library.
 */
export { createJsonRpcClient, EvmRpcError } from './client';
export type { Eip1193Client } from './client';
export {
  getEvmProtocolConfig,
  clearEvmProtocolConfigCache,
  WrongEvmChainError,
  MAX_EVM_FEE_BPS,
} from './config';
export type { EvmProtocolConfig, GetEvmProtocolConfigOptions } from './config';
export { readHexData, readQuantity, readWords, readUint256, readAddressWord } from './rpc-read';
