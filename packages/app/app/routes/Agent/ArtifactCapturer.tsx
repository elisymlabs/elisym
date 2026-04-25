import { toDTag, type CapabilityCard } from '@elisym/sdk';
import { useEffect, useRef } from 'react';
import type { Artifact, BuyState } from './types';

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
      prompt: buyState.lastInput || undefined,
      capability: toDTag(card.name),
    });
  }, [buyState?.result, buyState?.jobId, buyState?.lastInput, card, onCapture]);

  return null;
}
