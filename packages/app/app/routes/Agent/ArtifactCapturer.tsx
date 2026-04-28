import {
  resolveKnownAsset,
  toDTag,
  type CapabilityCard,
  type PaymentAssetRef,
  type PaymentInfo,
} from '@elisym/sdk';
import { useEffect, useRef } from 'react';
import type { Artifact, BuyState } from './types';

function paymentToAsset(payment: PaymentInfo | undefined): PaymentAssetRef | undefined {
  if (!payment || !payment.token || payment.token === 'sol') {
    return undefined;
  }
  const known = resolveKnownAsset(payment.chain, payment.token, payment.mint);
  if (known) {
    return { chain: known.chain, token: known.token, mint: known.mint, decimals: known.decimals };
  }
  if (payment.decimals === undefined) {
    return undefined;
  }
  return {
    chain: payment.chain,
    token: payment.token,
    mint: payment.mint,
    decimals: payment.decimals,
  };
}

interface Props {
  buyState: BuyState | null;
  card: CapabilityCard | undefined;
  onCapture: (artifact: Artifact) => void;
}

export function ArtifactCapturer({ buyState, card, onCapture }: Props) {
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!buyState?.result || !buyState.jobId || !card) {
      return;
    }
    if (lastIdRef.current === buyState.jobId) {
      return;
    }
    lastIdRef.current = buyState.jobId;
    onCapture({
      id: buyState.jobId,
      cardName: card.name,
      result: buyState.result,
      createdAt: Date.now(),
      priceLamports: card.payment?.job_price,
      asset: paymentToAsset(card.payment),
      prompt: buyState.lastInput || undefined,
      capability: toDTag(card.name),
    });
  }, [buyState?.result, buyState?.jobId, buyState?.lastInput, card, onCapture]);

  return null;
}
