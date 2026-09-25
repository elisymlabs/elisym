/**
 * The money core: what a payment is, how it is built, and how it is proved.
 *
 * Every export here used to live in `@elisym/sdk` and still does - the SDK
 * re-exports this package unchanged, so nothing that imported them has to
 * move. What changed is who owns them: a checkout, a merchant node and an
 * agent wallet need this and none of the marketplace around it.
 */

export {
  buildPaymentInstructions,
  createPaymentRequestWithOnchainConfig,
  SolanaPaymentStrategy,
} from './payment/solana';
export {
  boundTransferAmount,
  composeSolanaPaymentRequest,
  directInstructionsFromCompiledMessage,
  directInstructionsFromRpcTransaction,
  listReferenceSignatures,
  verifyDirectSolanaPayment,
} from './payment/direct';
export type {
  BoundTransferExpectation,
  ComposeSolanaPaymentRequestOptions,
  DirectInstruction,
  DirectVerification,
  ListReferenceSignaturesOptions,
  ReferenceSignature,
} from './payment/direct';
export { calculateProtocolFee, validateExpiry, assertExpiry, assertLamports } from './payment/fee';
export type {
  BuildTransactionOptions,
  PaymentStrategy,
  ProtocolConfigInput,
  Signer,
} from './payment/strategy';
export {
  estimatePriorityFeeMicroLamports,
  clearPriorityFeeCache,
  pickPercentileFee,
} from './payment/priorityFee';
export type { EstimatePriorityFeeOptions } from './payment/priorityFee';
export {
  estimateAssetStatsRentLamports,
  estimateSolFeeLamports,
  formatFeeBreakdown,
  estimateNetworkBaseline,
  formatNetworkBaseline,
} from './payment/feeEstimate';
export type {
  SolFeeEstimate,
  EstimateSolFeeOptions,
  NetworkBaselineEstimate,
  NetworkBaselineOptions,
} from './payment/feeEstimate';
export { PaymentRequestSchema, parsePaymentRequest } from './payment/schema';
export type { ParsedPaymentRequest, ParseOptions, ParseResult } from './payment/schema';
export {
  PaymentRequestV2Schema,
  parseAnyPaymentRequest,
  resolveAssetFromPaymentRequestV2,
  caip19ForAsset,
} from './payment/schema-v2';
export type {
  ParsedPaymentRequestV2,
  ParseAnyOptions,
  AnyParseError,
  AnyParseResult,
} from './payment/schema-v2';
export { calculateProtocolFeeSubunits } from './payment/fee-subunits';
export {
  CHAINS,
  isChainSlug,
  chainFamilyOf,
  chainFor,
  chainByCaip2,
  explorerTxUrl,
  isEvmAddressFormat,
  isEvmTxHashFormat,
  isEvmWireAddress,
  isEvmWireTxHash,
  isVirtualEvmAddress,
  normalizeEvmAddress,
} from './payment/chains';
export type { ChainSlug, ChainFamily, ChainConfig } from './payment/chains';
export { ProviderPaymentAcceptor, MIN_SETTLEMENT_RETENTION_MS } from './payment/acceptor';
export type {
  SettlementClaim,
  SettlementStore,
  AcceptPaymentInput,
  AcceptPaymentResult,
} from './payment/acceptor';
export { degenerateReference, degenerateReferenceSync } from './payment/degenerate-reference';
export type { DegenerateReferenceCode } from './payment/degenerate-reference';
export { verifyJobPaymentQuick, clearQuickVerifyCache } from './payment/quick-verify';
export type { QuickVerifyResult, QuickVerifyReason } from './payment/quick-verify';
export {
  isDefinitelyUnpaid,
  buildSignedPull,
  sendConfirmToTerminal,
  confirmPullToTerminal,
} from './payment/settlement';
export type {
  SignedPullTransaction,
  PullTerminalOutcome,
  BuildSignedPullOptions,
  ConfirmToTerminalOptions,
} from './payment/settlement';
export { aggregateNetworkStats, getNetworkStats } from './payment/analytics';
export type {
  AggregateNetworkStatsOptions,
  NetworkStatsResult,
  OnchainNetworkStats,
} from './payment/analytics';
export {
  NATIVE_SOL,
  USDC_SOLANA_DEVNET,
  USDC_SOLANA_MAINNET,
  LSM_SOLANA_MAINNET,
  TOKEN_2022_PROGRAM_ADDRESS_STR,
  USDCE_TEMPO_MAINNET,
  PATHUSD_TEMPO,
  KNOWN_ASSETS,
  EVM_ASSETS,
  ALL_ASSETS,
  assetsFor,
  defaultStablecoin,
  assetKey,
  assetByKey,
  resolveKnownAsset,
  resolveUsdcAsset,
  resolveLsmAsset,
  splAssetsForNetwork,
  resolveAssetFromPaymentRequest,
  parseAssetAmount,
  formatAssetAmount,
} from './payment/assets';
export type { Asset, Chain } from './payment/assets';
export {
  encodeSecretKeyBase58,
  exportKeyPairBytes,
  generateSolanaWallet,
  signerFromSecretKeyBase58,
} from './payment/wallet';
export { clearProtocolConfigCache, getProtocolConfig } from './config/onchain';
export type { GetProtocolConfigOptions, ProtocolConfig } from './config/onchain';
export type {
  Network,
  PaymentValidationCode,
  VerifyOptions,
  VerifyRefusalCode,
  PaymentAssetRef,
  PaymentRequestData,
  PaymentValidationError,
  VerifyResult,
} from './types';
export {
  ELISYM_PROTOCOL_TAG,
  getProtocolProgramId,
  PROTOCOL_PROGRAM_ID_DEVNET,
  PROTOCOL_PROGRAM_ID_MAINNET,
  type ProtocolCluster,
} from './constants';
