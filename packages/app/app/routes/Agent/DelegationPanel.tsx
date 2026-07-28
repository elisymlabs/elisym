import {
  buildApproveDelegate,
  buildRevokeDelegate,
  decodeApproveDelegate,
  decodeDelegationFeeTransfer,
  delegationApproveFeeSubunits,
  deriveOwnerDelegationAta,
  estimatePriorityFeeMicroLamports,
  formatAssetAmount,
  formatDelegationGrant,
  getDelegation,
  getProtocolConfig,
  getProtocolProgramId,
  parseAssetAmount,
  truncateKey,
  USDC_SOLANA_DEVNET,
  type DelegationDescriptor,
  type DelegationStatus,
} from '@elisym/sdk';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
// VersionedTransaction is the only @solana/web3.js type this file touches - the
// wallet-adapter `sendTransaction` accepts it. Same bridge as BuyContext; do not
// grow web3.js usage, everything else is Kit.
import { VersionedTransaction } from '@solana/web3.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { invalidateWalletBalances } from '~/hooks/useWalletBalances';
import { SDK_CLUSTER, SOLANA_RPC_URL } from '~/lib/cluster';
import { cn } from '~/lib/cn';

const COMPUTE_UNIT_LIMIT = 200_000;
const PRIORITY_FEE_PERCENTILE = 75;
const NETWORK = 'devnet' as const;
const kitRpc = createSolanaRpc(SOLANA_RPC_URL);
const PROTOCOL_PROGRAM_ID = getProtocolProgramId(SDK_CLUSTER);

interface VersionedTx {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Build an unsigned versioned transaction from Kit instructions, bridged to a
 * wallet-adapter-signable `VersionedTransaction`. Mirrors BuyContext's
 * `buildVersionedPaymentTransaction`.
 */
async function buildVersionedTx(
  instructions: readonly unknown[],
  payerAddress: string,
): Promise<VersionedTx> {
  const payerSigner = createNoopSigner(address(payerAddress));
  const priorityFeeMicroLamports = await estimatePriorityFeeMicroLamports(kitRpc, {
    percentile: PRIORITY_FEE_PERCENTILE,
  });
  const { value: latestBlockhash } = await kitRpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payerSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => setTransactionMessageComputeUnitLimit(COMPUTE_UNIT_LIMIT, m),
    (m) => setTransactionMessageComputeUnitPrice(priorityFeeMicroLamports, m),
    (m) =>
      appendTransactionMessageInstructions(
        instructions as Parameters<typeof appendTransactionMessageInstructions>[0],
        m,
      ),
  );
  const compiled = compileTransaction(message);
  const wireBase64 = getBase64EncodedWireTransaction(compiled);
  const wireBytes = Uint8Array.from(atob(wireBase64), (character) => character.charCodeAt(0));
  return {
    tx: VersionedTransaction.deserialize(wireBytes),
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: Number(latestBlockhash.lastValidBlockHeight),
  };
}

/**
 * Keep only what forms a valid USDC amount: digits and a single decimal point,
 * with at most `decimals` fractional digits. Strips letters, spaces, and extra
 * dots so the field can never hold a non-numeric string that `parseAssetAmount`
 * would later reject.
 */
function sanitizeCapInput(raw: string, decimals: number): string {
  const digitsAndDots = raw.replace(/[^0-9.]/g, '');
  const firstDot = digitsAndDots.indexOf('.');
  if (firstDot === -1) {
    return digitsAndDots;
  }
  const intPart = digitsAndDots.slice(0, firstDot);
  const fracPart = digitsAndDots
    .slice(firstDot + 1)
    .replace(/\./g, '')
    .slice(0, decimals);
  return `${intPart}.${fracPart}`;
}

interface Props {
  delegation: DelegationDescriptor;
  agentName: string;
}

export function DelegationPanel({ delegation, agentName }: Props) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const queryClient = useQueryClient();
  const [capInput, setCapInput] = useState('');
  const [status, setStatus] = useState<DelegationStatus | null | 'loading' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  // Monotonic request id: only the most recent refreshStatus may apply its
  // result. Without it, a slow read for a previous wallet could resolve after a
  // wallet switch and paint the wrong account's delegation (wrong revoke target).
  const requestIdRef = useRef(0);

  const ownerAddress = publicKey?.toBase58();

  // Protocol fee config for the live preview + fail-closed approve. Fetched on
  // mount / cluster change; the authoritative value is re-read at approve time.
  const { data: protocolConfig, isError: configError } = useQuery({
    queryKey: ['delegation-protocol-config', SDK_CLUSTER],
    queryFn: () => getProtocolConfig(kitRpc, PROTOCOL_PROGRAM_ID),
    staleTime: 60_000,
  });

  const refreshStatus = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!ownerAddress) {
      setStatus(null);
      return;
    }
    setStatus('loading');
    try {
      const ownerAta = await deriveOwnerDelegationAta(ownerAddress, NETWORK);
      // getDelegation returns null when the ATA does not exist (no USDC, hence
      // no delegation) and THROWS on a real RPC failure - so an outage does not
      // masquerade as "no delegation" and silently hide a live allowance/revoke.
      const next = await getDelegation(kitRpc, ownerAta);
      if (requestIdRef.current === requestId) {
        setStatus(next);
      }
    } catch {
      if (requestIdRef.current === requestId) {
        setStatus('error');
      }
    }
  }, [ownerAddress]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function handleApprove() {
    if (!ownerAddress) {
      toast.error('Connect a wallet first.');
      return;
    }
    let capSubunits: bigint;
    try {
      capSubunits = parseAssetAmount(USDC_SOLANA_DEVNET, capInput);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Enter a valid USDC cap.');
      return;
    }

    setBusy(true);
    const toastId = 'delegation-approve';
    try {
      // Fail-closed: the approve charges the protocol fee, so a config we cannot
      // read means we cannot know the fee - refuse rather than approve fee-free.
      let feeBps: number;
      let treasury: string;
      try {
        const cfg = await getProtocolConfig(kitRpc, PROTOCOL_PROGRAM_ID);
        feeBps = cfg.feeBps;
        treasury = cfg.treasury;
      } catch {
        throw new Error('Could not read the protocol fee config. Try again.');
      }
      const feeSubunits = feeBps > 0 ? delegationApproveFeeSubunits(capSubunits, feeBps) : 0n;

      const instructions = await buildApproveDelegate({
        owner: createNoopSigner(address(ownerAddress)),
        delegate: delegation.delegate_pubkey,
        capSubunits,
        network: NETWORK,
        fee: feeSubunits > 0n ? { feeBps, treasury } : undefined,
      });
      // Independent transparency check: decode the exact approveChecked we built
      // and confirm it grants what the owner asked - delegate, cap, AND the
      // recognized USDC mint. The wallet's own simulation is the final check.
      const decoded = decodeApproveDelegate(instructions[1]);
      if (
        decoded.delegate !== delegation.delegate_pubkey ||
        decoded.capSubunits !== capSubunits ||
        !decoded.recognized ||
        decoded.mint !== USDC_SOLANA_DEVNET.mint
      ) {
        throw new Error('Built approval did not match the requested grant. Aborting.');
      }
      // Verify the fee leg too (defense-in-depth). deriveOwnerDelegationAta(addr)
      // is the USDC ATA of `addr`, so it yields the treasury's fee ATA.
      if (instructions.length === 4) {
        const treasuryAta = await deriveOwnerDelegationAta(treasury, NETWORK);
        const feeLeg = decodeDelegationFeeTransfer(instructions[3]);
        if (
          feeLeg.destination !== String(treasuryAta) ||
          feeLeg.amount !== feeSubunits ||
          feeLeg.mint !== USDC_SOLANA_DEVNET.mint
        ) {
          throw new Error('Built fee transfer did not match the expected protocol fee. Aborting.');
        }
      }
      const feeNote =
        feeSubunits > 0n
          ? ` (+ ${formatAssetAmount(USDC_SOLANA_DEVNET, feeSubunits)} protocol fee)`
          : '';
      toast.loading(`${formatDelegationGrant(decoded)}${feeNote} Approve in your wallet...`, {
        id: toastId,
      });

      const { tx, blockhash, lastValidBlockHeight } = await buildVersionedTx(
        instructions,
        ownerAddress,
      );
      const signature = await sendTransaction(tx, connection);
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (confirmation.value.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }
      toast.success(
        `Granted delegate up to ${formatAssetAmount(USDC_SOLANA_DEVNET, capSubunits)}.`,
        {
          id: toastId,
        },
      );
      setCapInput('');
      invalidateWalletBalances(queryClient, ownerAddress);
      await refreshStatus();
    } catch (error) {
      // Dismiss-then-error, not a same-id swap: Sonner does not reliably swap a
      // `toast.loading` chain to an error toast (the spinner can stick), which
      // would hide a wallet rejection / on-chain failure. Mirrors BuyContext.
      toast.dismiss(toastId);
      toast.error(error instanceof Error ? error.message : 'Approval failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    if (!ownerAddress) {
      return;
    }
    setBusy(true);
    const toastId = 'delegation-revoke';
    try {
      const instructions = await buildRevokeDelegate({
        owner: createNoopSigner(address(ownerAddress)),
        network: NETWORK,
      });
      toast.loading('Revoke the allowance in your wallet...', { id: toastId });
      const { tx, blockhash, lastValidBlockHeight } = await buildVersionedTx(
        instructions,
        ownerAddress,
      );
      const signature = await sendTransaction(tx, connection);
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (confirmation.value.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }
      toast.success('Allowance revoked. Future spend is stopped.', { id: toastId });
      invalidateWalletBalances(queryClient, ownerAddress);
      await refreshStatus();
    } catch (error) {
      // Dismiss-then-error (see handleApprove): a same-id swap can leave the
      // loading spinner stuck and hide the failure.
      toast.dismiss(toastId);
      toast.error(error instanceof Error ? error.message : 'Revoke failed.');
    } finally {
      setBusy(false);
    }
  }

  const loaded = status !== null && status !== 'loading' && status !== 'error' ? status : null;
  const activeDelegate = loaded && loaded.delegate === delegation.delegate_pubkey ? loaded : null;
  // The account already delegates to a DIFFERENT key. An SPL account has exactly
  // one delegate, so granting here REPLACES it - surface that instead of letting
  // a "Grant allowance" button silently wipe another agent's live allowance.
  const otherDelegate =
    loaded && loaded.delegate !== null && loaded.delegate !== delegation.delegate_pubkey
      ? loaded
      : null;

  // Live fee preview + balance pre-check. The fee is feeBps of the cap, a real USDC
  // transfer at approve, so the owner must hold it now (the cap stays decoupled from
  // balance, but the FEE does not). Guard the compute so an unparsed / absurd cap
  // cannot throw during render.
  const feeBps = protocolConfig?.feeBps ?? 0;
  let feePreviewSubunits: bigint | null = null;
  try {
    if (/\d/.test(capInput)) {
      feePreviewSubunits =
        feeBps > 0
          ? delegationApproveFeeSubunits(parseAssetAmount(USDC_SOLANA_DEVNET, capInput), feeBps)
          : 0n;
    }
  } catch {
    feePreviewSubunits = null;
  }
  const usdcBalance = loaded?.balance ?? 0n;
  // Only assert insufficiency when the balance is actually KNOWN: a resolved read
  // (a DelegationStatus, or null=no-ATA which is a genuine 0). During loading/error
  // the balance is unknown, so do not block/warn on a false 0 - the action-time
  // config read and the atomic on-chain revert are the backstop.
  const balanceKnown = ownerAddress !== undefined && status !== 'loading' && status !== 'error';
  const insufficientForFee =
    balanceKnown &&
    feePreviewSubunits !== null &&
    feePreviewSubunits > 0n &&
    usdcBalance < feePreviewSubunits;

  return (
    <div className="max-w-[640px]">
      <h3 className="m-0 text-sm font-semibold text-text">Delegated spend (spl-approve)</h3>
      <p className="mt-8 text-sm leading-relaxed text-text-2">
        Grant {agentName} a bounded USDC allowance it can spend autonomously - no per-action
        signature. You approve delegate{' '}
        <span className="font-mono text-[12px]">{truncateKey(delegation.delegate_pubkey)}</span> for
        a cap you choose.
      </p>

      <div className="mt-16 rounded-12 border border-border bg-surface-2 p-14">
        <p className="m-0 text-[12px] leading-relaxed text-text-2">
          <span className="font-semibold text-text">Max loss is your cap.</span> Within it the agent
          picks the destination, including its own account - this is bounded trust, not theft-proof.
          A new approval <span className="font-semibold">replaces</span> the remaining cap (a top-up
          is a re-grant). Revoke stops only future spend once it lands. USDC only.
        </p>
      </div>

      {status === 'error' && ownerAddress ? (
        <div className="mt-16 rounded-12 border border-border bg-surface-2 p-14">
          <p className="m-0 text-[12px] leading-relaxed text-text-2">
            Could not read your current allowance (network error). Any existing delegation is
            unchanged.{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => void refreshStatus()}
              className="font-semibold text-accent underline"
            >
              Retry
            </button>
          </p>
        </div>
      ) : null}

      {otherDelegate ? (
        <div className="mt-16 rounded-12 border border-border bg-surface-2 p-14">
          <p className="m-0 text-[12px] leading-relaxed text-text-2">
            <span className="font-semibold text-text">Heads up:</span> this account already
            delegates to a different key (
            <span className="font-mono text-[12px]">
              {truncateKey(otherDelegate.delegate ?? '')}
            </span>
            ) with {formatAssetAmount(USDC_SOLANA_DEVNET, otherDelegate.remainingCap)} remaining.
            Granting {agentName} an allowance here will{' '}
            <span className="font-semibold">replace</span> that delegation - an account can have
            only one delegate at a time.
          </p>
        </div>
      ) : null}

      {activeDelegate ? (
        <div className="mt-16 rounded-12 border border-border bg-surface p-14">
          <p className="m-0 text-sm text-text">
            Active allowance:{' '}
            <span className="font-semibold">
              {formatAssetAmount(USDC_SOLANA_DEVNET, activeDelegate.remainingCap)}
            </span>{' '}
            remaining
          </p>
          <p className="mt-4 text-[12px] text-text-2">
            Balance: {formatAssetAmount(USDC_SOLANA_DEVNET, activeDelegate.balance)}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={handleRevoke}
            className="mt-12 inline-flex h-36 cursor-pointer items-center justify-center rounded-12 border border-border bg-transparent px-14 text-[13px] font-semibold text-text transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            Revoke allowance
          </button>
        </div>
      ) : null}

      <div className="mt-16">
        <label htmlFor="delegation-cap" className="block text-[12px] font-medium text-text-2">
          Cap (USDC) <span className="font-normal text-text-2/70">- you set the limit</span>
        </label>
        <div className="mt-6 flex items-center gap-8">
          <input
            id="delegation-cap"
            inputMode="decimal"
            value={capInput}
            disabled={busy || !ownerAddress}
            onChange={(event) =>
              setCapInput(sanitizeCapInput(event.target.value, USDC_SOLANA_DEVNET.decimals))
            }
            placeholder="e.g. 5"
            className={cn(
              'h-36 w-160 rounded-12 border border-border bg-surface px-12 text-[13px] text-text',
              'outline-none focus:border-accent',
            )}
          />
          <button
            type="button"
            disabled={
              busy || !ownerAddress || !/\d/.test(capInput) || configError || insufficientForFee
            }
            onClick={handleApprove}
            className="inline-flex h-36 cursor-pointer items-center justify-center rounded-12 bg-accent px-14 text-[13px] font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {activeDelegate ? 'Replace allowance' : 'Grant allowance'}
          </button>
        </div>
        {!ownerAddress && (
          <p className="mt-8 text-[12px] text-text-2">Connect a wallet to set an allowance.</p>
        )}
        {ownerAddress && feeBps > 0 && feePreviewSubunits !== null && feePreviewSubunits > 0n ? (
          <p className="mt-8 text-[12px] text-text-2">
            Protocol fee: {formatAssetAmount(USDC_SOLANA_DEVNET, feePreviewSubunits)}, charged now
            to the treasury (+ ~one-time ATA rent if the treasury account is new). You must hold
            this USDC.
          </p>
        ) : null}
        {insufficientForFee ? (
          <p className="mt-8 text-[12px] font-medium text-warning">
            Your USDC balance ({formatAssetAmount(USDC_SOLANA_DEVNET, usdcBalance)}) is below the
            protocol fee - deposit USDC to approve.
          </p>
        ) : null}
        {configError ? (
          <p className="mt-8 text-[12px] font-medium text-feedback-negative">
            Could not load the protocol fee - approve is disabled. Reconnect the wallet or retry.
          </p>
        ) : null}
      </div>
    </div>
  );
}
