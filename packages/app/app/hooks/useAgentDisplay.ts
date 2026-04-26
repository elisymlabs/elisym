import { truncateKey } from '@elisym/sdk';
import type { Agent, CapabilityCard } from '@elisym/sdk';
import { useMemo } from 'react';
import { formatCardPrice } from '~/lib/formatPrice';
import type { FeedbackMap, CapabilityStatsMap } from './useAgentFeedback';

/** Approximate "time ago" - rounds to coarse units with "~" prefix */
function approxTimeAgo(unix: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 5) {
    return '~a few min ago';
  }
  if (minutes < 60) {
    return `~${Math.round(minutes / 5) * 5}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `~${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `~${days}d ago`;
}

export interface AgentDisplayData {
  pubkey: string;
  npub: string;
  name: string;
  description: string;
  tags: string[];
  category: string;
  price: string;
  priceLamports: number | undefined;
  wallet: string;
  walletAddress: string;
  /** Newest network signal (capability publish, result, feedback). Used for the runtime "online" indicator only. */
  lastSeen: string;
  lastSeenTs: number;
  /**
   * Display label for the most recent on-chain-verified paid job. Undefined
   * for cold-start agents that have not had a verified paid job within the
   * SDK's ranking window. Source: `Agent.lastPaidJobAt` from
   * `DiscoveryService.fetchAgents` (requires Solana RPC in ElisymClient).
   */
  lastPaidJobLabel: string | undefined;
  lastPaidJobAt: number | undefined;
  picture: string | undefined;
  cards: CapabilityCard[];
  agent: Agent;
  feedbackPositive: number;
  feedbackNegative: number;
  feedbackTotal: number;
  purchases: number;
  byCapability: CapabilityStatsMap;
}

function toDisplayData(agent: Agent, feedbackMap?: FeedbackMap): AgentDisplayData {
  const cards = agent.cards;
  const firstCard = cards[0];

  // Use agent-level name/about from kind:0, fallback to truncated npub
  const name = agent.name || '';
  const description = agent.about || firstCard?.description || '';

  // Collect all tags from all cards
  const allTags = Array.from(new Set(cards.flatMap((c) => c.capabilities || [])));

  // Find the cheapest card. `Math.min` only makes sense within one asset,
  // so we also carry the source card to drive display formatting (USDC cards
  // should render as USDC, not lamports).
  const pricedCards = cards.filter(
    (c): c is CapabilityCard & { payment: NonNullable<CapabilityCard['payment']> } =>
      c.payment?.job_price !== null && c.payment?.job_price !== undefined,
  );
  const cheapestCard = pricedCards.reduce<(typeof pricedCards)[number] | undefined>((acc, c) => {
    if (!acc) {
      return c;
    }
    return (c.payment.job_price ?? 0) < (acc.payment.job_price ?? 0) ? c : acc;
  }, undefined);
  const price = cheapestCard?.payment.job_price;

  // Find any card with a wallet address
  const cardWithAddress = cards.find((c) => c.payment?.address);
  const walletAddress = cardWithAddress?.payment?.address || '';

  const fb = feedbackMap?.[agent.pubkey];

  const effectivePrice = price ?? 0;
  const priceLabel =
    effectivePrice === 0 ? 'Free' : formatCardPrice(cheapestCard?.payment, effectivePrice);

  return {
    pubkey: agent.pubkey,
    npub: agent.npub,
    name,
    description,
    tags: allTags,
    category: allTags[0] || 'other',
    price: priceLabel,
    priceLamports: price,
    wallet: walletAddress ? truncateKey(walletAddress, 4) : '',
    walletAddress,
    lastSeen: approxTimeAgo(agent.lastSeen),
    lastSeenTs: agent.lastSeen,
    lastPaidJobLabel: agent.lastPaidJobAt ? approxTimeAgo(agent.lastPaidJobAt) : undefined,
    lastPaidJobAt: agent.lastPaidJobAt,
    picture: agent.picture,
    cards,
    agent,
    feedbackPositive: fb?.positive ?? 0,
    feedbackNegative: fb?.negative ?? 0,
    feedbackTotal: fb?.total ?? 0,
    purchases: fb?.purchases ?? 0,
    byCapability: fb?.byCapability ?? {},
  };
}

export function useAgentDisplay(
  agents: Agent[] | undefined,
  feedbackMap?: FeedbackMap,
): AgentDisplayData[] {
  return useMemo(
    () => (agents ?? []).map((a) => toDisplayData(a, feedbackMap)),
    [agents, feedbackMap],
  );
}
