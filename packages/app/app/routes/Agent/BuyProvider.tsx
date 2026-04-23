import type { CapabilityCard } from '@elisym/sdk';
import type { ReactNode } from 'react';
import { useBuyCapability } from '~/hooks/useBuyCapability';
import type { BuyState } from './types';

interface InnerProps {
  card: CapabilityCard;
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  children: (state: BuyState) => ReactNode;
}

function BuyProviderInner({ card, agentPubkey, agentName, agentPicture, children }: InnerProps) {
  const state = useBuyCapability({ agentPubkey, agentName, agentPicture, card });
  return <>{children(state)}</>;
}

interface Props {
  card: CapabilityCard | undefined;
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  children: (state: BuyState | null) => ReactNode;
}

export function BuyProvider({ card, agentPubkey, agentName, agentPicture, children }: Props) {
  if (!card) {
    return <>{children(null)}</>;
  }
  return (
    <BuyProviderInner
      key={card.name}
      card={card}
      agentPubkey={agentPubkey}
      agentName={agentName}
      agentPicture={agentPicture}
    >
      {children}
    </BuyProviderInner>
  );
}
