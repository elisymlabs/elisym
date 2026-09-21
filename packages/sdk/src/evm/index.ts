/**
 * `@elisym/sdk/evm` - the EVM payment rail.
 *
 * What lives here needs an rpc; the shape checks and the registry that need
 * none are in the root entry (`payment/chains`). The rpc is an EIP-1193
 * `request`, so reading and verifying pull in no EVM library.
 */
export { createJsonRpcClient, DEFAULT_RPC_TIMEOUT_MS, EvmRpcError, withAbort } from './client';
export type { Eip1193Client, JsonRpcClientOptions } from './client';
export {
  getEvmProtocolConfig,
  checkEvmChain,
  clearEvmProtocolConfigCache,
  WrongEvmChainError,
  MAX_EVM_FEE_BPS,
} from './config';
export type { EvmProtocolConfig, GetEvmProtocolConfigOptions } from './config';
export { readHexData, readQuantity, readWords, readUint256, readAddressWord } from './rpc-read';
export {
  createTempoPaymentRequest,
  type CreateTempoPaymentRequestOptions,
  type TempoPaymentRequestCreation,
} from './request';
export {
  verifyTempoPayment,
  tempoSettlementId,
  type TempoVerifyResult,
  type TempoInconclusiveReason,
  type TempoRefusalCode,
  type VerifyTempoPaymentOptions,
} from './verify';
export {
  listTempoLogs,
  listTempoBlockedLogs,
  readFinalizedBlock,
  type ListBlockedLogsOptions,
  type ListTempoLogsOptions,
  type TempoBlockedLog,
  type TempoBlockedScan,
  type TempoBlockRef,
  type TempoLogScan,
  type TempoTransferEvent,
  type TempoTransferLog,
} from './logs';
export { readTempoReceivePolicy, type TempoReceivePolicy } from './policy';
export {
  validateTempoPaymentRequest,
  checkTempoReceivePolicies,
  MIN_PAY_WINDOW_SECS,
  type TempoPaymentBounds,
  type ReceivePolicyCheck,
  type ReceivePolicyVerdict,
} from './validate';
export {
  resolveTempoTransferOutcome,
  type TempoLegExpectation,
  type TempoTransferOutcome,
  type ResolveTempoTransferOptions,
} from './outcome';
export {
  EVM_LATE_PAYMENT_GRACE_SECS,
  TEMPO_LIVE_NOHASH_BUDGET_MS,
  MAX_LOG_BLOCK_RANGE,
} from './constants';
