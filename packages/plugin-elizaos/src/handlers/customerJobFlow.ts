import type {
  ElisymClient,
  ElisymIdentity,
  PaymentRequestData,
  ProtocolConfigInput,
  SolanaPaymentStrategy,
} from '@elisym/sdk';
import {
  getProtocolConfig,
  getProtocolProgramId,
  SolanaPaymentStrategy as SolanaPaymentStrategyCtor,
} from '@elisym/sdk';
import {
  createSolanaRpcSubscriptions,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
} from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { logger } from '../lib/logger';
import { deriveWsUrl } from '../lib/solana';
import type { SpendingReservation } from '../lib/spendingGuard';
import type { WalletService } from '../services/WalletService';
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

export interface ExecutePaymentInput {
  client: ElisymClient;
  identity: ElisymIdentity;
  wallet: WalletService;
  network: ElisymNetwork;
  jobEventId: string;
  providerPubkey: string;
  expectedRecipient: string;
  paymentRequestJson: string;
  maxPriceLamports: bigint;
  reservation?: SpendingReservation;
}

export interface ExecutePaymentResult {
  txSignature: string;
  paidLamports: bigint;
}

export async function executePaymentFlow(
  input: ExecutePaymentInput,
): Promise<ExecutePaymentResult> {
  let requestData: PaymentRequestData;
  try {
    requestData = JSON.parse(input.paymentRequestJson) as PaymentRequestData;
  } catch {
    throw new Error('Provider sent a malformed payment_request (not valid JSON).');
  }

  if (!Number.isInteger(requestData.amount) || requestData.amount <= 0) {
    throw new Error(`Payment request contained an invalid amount: ${requestData.amount}`);
  }
  const amountLamports = BigInt(requestData.amount);
  if (amountLamports > input.maxPriceLamports) {
    throw new Error(
      `Provider-signed amount ${amountLamports} exceeds approved max ${input.maxPriceLamports}`,
    );
  }

  const protocolConfig = await fetchProtocolConfig(input.wallet.rpc, input.network);

  const validation = paymentStrategy.validatePaymentRequest(
    input.paymentRequestJson,
    protocolConfig,
    input.expectedRecipient,
  );
  if (validation !== null) {
    throw new Error(`Payment validation failed: ${validation.message}`);
  }

  const signedTx = await paymentStrategy.buildTransaction(
    requestData,
    input.wallet.signer,
    input.wallet.rpc,
    protocolConfig,
  );

  const rpcSubscriptions = createSolanaRpcSubscriptions(deriveWsUrl(input.wallet.rpcUrl));
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc: input.wallet.rpc,
    rpcSubscriptions,
  });
  await sendAndConfirm(signedTx as Parameters<typeof sendAndConfirm>[0], {
    commitment: 'confirmed',
  });
  const txSignature = getSignatureFromTransaction(
    signedTx as Parameters<typeof getSignatureFromTransaction>[0],
  );

  if (input.reservation) {
    input.reservation.release();
  }
  input.wallet.recordSpend(amountLamports);

  try {
    await input.client.marketplace.submitPaymentConfirmation(
      input.identity,
      input.jobEventId,
      input.providerPubkey,
      txSignature,
    );
  } catch (error) {
    logger.error(
      { err: error, jobEventId: input.jobEventId },
      'Solana tx confirmed but Nostr payment confirmation failed',
    );
  }

  return { txSignature, paidLamports: amountLamports };
}
