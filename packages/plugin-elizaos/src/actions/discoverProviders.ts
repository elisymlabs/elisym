import type { Agent } from '@elisym/sdk';
import type { Action, ActionResult, IAgentRuntime, Memory, State } from '@elizaos/core';
import { DISCOVERY_TTL_MS, SERVICE_TYPES } from '../constants';
import { logger } from '../lib/logger';
import { formatLamportsAsSol } from '../lib/pricing';
import type { ElisymService } from '../services/ElisymService';
import { getState, hasState } from '../state';

const TRIGGER_PATTERN = /\b(find|search|discover|look|hire|need|provider|agent)\b|\belisym\b/i;

function extractCapability(text: string, explicit?: string): string | null {
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const quoted = /"([^"]+)"|'([^']+)'|`([^`]+)`/.exec(text);
  if (quoted) {
    return (quoted[1] ?? quoted[2] ?? quoted[3] ?? '').trim();
  }
  const afterFor = /\bfor\s+([a-z][a-z0-9_\-/]{1,63})\b/i.exec(text);
  if (afterFor && afterFor[1]) {
    return afterFor[1].toLowerCase();
  }
  return null;
}

function matchesCapability(agent: Agent, capability: string): boolean {
  const needle = capability.toLowerCase();
  return agent.cards.some((card) =>
    card.capabilities.some((value) => value.toLowerCase().includes(needle)),
  );
}

function summarize(agents: Agent[]): string {
  const lines: string[] = [`Found ${agents.length} elisym provider(s):`];
  agents.slice(0, 5).forEach((agent, index) => {
    const card = agent.cards[0];
    const price = card?.payment?.job_price
      ? `${formatLamportsAsSol(BigInt(card.payment.job_price))} SOL`
      : 'price on request';
    const name = agent.name ?? card?.name ?? agent.pubkey.slice(0, 8);
    const caps = card?.capabilities.join(', ') ?? 'unknown';
    lines.push(`${index + 1}. ${name} - ${caps} - ${price} - npub ${agent.npub.slice(0, 20)}...`);
  });
  return lines.join('\n');
}

export const discoverProvidersAction: Action = {
  name: 'ELISYM_DISCOVER_PROVIDERS',
  similes: ['FIND_AGENT', 'SEARCH_ELISYM', 'LOOK_FOR_PROVIDER'],
  description: 'Search the elisym network for providers that offer a specific capability.',
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!hasState(runtime)) {
      return false;
    }
    const { config } = getState(runtime);
    if (config.mode === 'provider') {
      return false;
    }
    const text = message.content.text ?? '';
    return TRIGGER_PATTERN.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: { [key: string]: unknown } | undefined,
    callback,
  ): Promise<ActionResult> => {
    const state = getState(runtime);
    const { config } = state;

    const explicit = typeof options?.capability === 'string' ? options.capability : undefined;
    const capability = extractCapability(message.content.text ?? '', explicit);

    const elisym = runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
    if (!elisym) {
      throw new Error('ElisymService is not running');
    }
    const client = elisym.getClient();

    let agents = await client.discovery.fetchAgents(config.network, 50);
    await client.discovery.enrichWithMetadata(agents);
    if (capability) {
      agents = agents.filter((agent) => matchesCapability(agent, capability));
    }
    agents.sort((a, b) => {
      const priceA = Number(a.cards[0]?.payment?.job_price ?? Number.MAX_SAFE_INTEGER);
      const priceB = Number(b.cards[0]?.payment?.job_price ?? Number.MAX_SAFE_INTEGER);
      return priceA - priceB;
    });
    const top = agents.slice(0, 5);

    const now = Date.now();
    state.lastDiscovery = {
      query: capability ?? '(any capability)',
      candidates: top.map((agent) => {
        const card = agent.cards[0];
        return {
          pubkey: agent.pubkey,
          name: agent.name ?? card?.name,
          capabilities: card?.capabilities ?? [],
          priceLamports: card?.payment?.job_price ? BigInt(card.payment.job_price) : undefined,
          address: card?.payment?.address,
        };
      }),
      ts: now,
      expiresAt: now + DISCOVERY_TTL_MS,
    };

    const text =
      top.length === 0
        ? `No elisym providers found${capability ? ` offering "${capability}"` : ''}.`
        : summarize(top);

    logger.info({ count: top.length, capability }, 'elisym discover completed');
    await callback?.({ text, source: 'elisym' });
    return { success: true, text, data: { providers: top.map((agent) => agent.npub) } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Find me an elisym summarization agent' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Searching the elisym network for summarization providers...',
          actions: ['ELISYM_DISCOVER_PROVIDERS'],
        },
      },
    ],
  ],
};
