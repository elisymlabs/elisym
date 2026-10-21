/**
 * `@elisym/pay-core/evm` - the EVM payment rail (re-exported as `@elisym/sdk/evm`).
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
export {
  readHexData,
  readQuantity,
  readWords,
  readUint256,
  readAddressWord,
  readTxHash,
} from './rpc-read';
export {
  buildTempoPaymentCalls,
  composeTempoPaymentRequest,
  encodeTransferWithMemo,
  type ComposeTempoPaymentRequestOptions,
  type TempoCall,
  type TempoPaymentCalls,
  type TempoPaymentLeg,
} from './pay';
export {
  createTempoPaymentRequest,
  randomTempoMemo,
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
  listTempoMarkedTransfers,
  readBlockByNumber,
  readFinalizedBlock,
  type ListBlockedLogsOptions,
  type ListTempoLogsOptions,
  type ListTempoMarkedTransfersOptions,
  type TempoBlockedLog,
  type TempoBlockedScan,
  type TempoBlockRef,
  type TempoHeadRef,
  type TempoLogScan,
  type TempoTransferEvent,
  type TempoTransferLog,
} from './logs';
export {
  readTempoReceiptLegs,
  type ReadTempoReceiptLegsOptions,
  type TempoReceiptLegs,
} from './receipt-legs';
export {
  canReceiveFrom,
  canStrangerReceive,
  readTempoReceivePolicy,
  type TempoReceivePolicy,
} from './policy';
export {
  validateTempoPaymentRequest,
  checkTempoReceivePolicies,
  MIN_PAY_WINDOW_SECS,
  type TempoPaymentBounds,
  type TempoPaymentCard,
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
  MAX_ISSUER_CLOCK_SKEW_SECS,
  MAX_LOG_BLOCK_RANGE,
  TEMPO_LIVE_NOHASH_BUDGET_MS,
  TEMPO_UNPAYABLE_ADDRESSES,
} from './constants';
export {
  AUTHORIZATION_CANCELED_TOPIC,
  AUTHORIZATION_USED_TOPIC,
  FIAT_TOKEN_IMPLEMENTATION_SLOT,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  buildTransferAuthorization,
  encodeTransferWithAuthorization,
  estimateTransferWithAuthorization,
  expectedDomainSeparator,
  findAssetTransferNear,
  hashTransferAuthorization,
  listAuthorizationsByNonce,
  listPayoutTransfers,
  normalizeAuthorizationSignature,
  readAuthorizationBinding,
  readAuthorizationCanceled,
  readAuthorizationUsed,
  readBlockAtTag,
  readDomainSeparator,
  readEip3009Legs,
  readEip3009Preflight,
  readFinalizedBlockWithHash,
  readImplementation,
  readL1Fee,
  type AssetTransferNear,
  type AuthorizationBinding,
  type AuthorizationCanceledScan,
  type AuthorizationState,
  type BlockTag,
  type BuildTransferAuthorizationOptions,
  type Eip3009AuthorizationLog,
  type Eip3009BlockRef,
  type Eip3009Leg,
  type Eip3009Legs,
  type Eip3009LogRef,
  type Eip3009Preflight,
  type Eip3009RangeOptions,
  type Eip3009TransferLog,
  type GasEstimate,
  type LogWalk,
  type PayerCode,
  type PinnedBlock,
  type ReadEip3009LegsOptions,
  type TransferAuthorizationMessage,
  type TransferAuthorizationTypedData,
} from './eip3009';
