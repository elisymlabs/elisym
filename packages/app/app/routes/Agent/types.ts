import type { useBuyCapability } from '~/hooks/useBuyCapability';

export type BuyState = ReturnType<typeof useBuyCapability>;

export interface Artifact {
  id: string;
  cardName: string;
  result: string;
  createdAt: number;
  priceLamports?: number;
  prompt?: string;
  capability?: string;
}

export interface ActivityEvent {
  id: string;
  createdAt: number;
  capability?: string;
  amountLamports?: number;
}
