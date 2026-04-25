import { formatAssetAmount } from '@elisym/sdk';
import { z } from 'zod';
import { sanitizeField, sanitizeUntrusted } from '../sanitize.js';
import { assetFromCardPayment } from '../utils.js';
import type { ToolDefinition } from './types.js';
import { defineTool, textResult } from './types.js';

const GetDashboardSchema = z.object({
  top_n: z.number().int().min(1).max(100).default(10),
  chain: z.enum(['solana']).default('solana'),
  network: z.enum(['devnet']).optional(),
  timeout_secs: z.number().int().min(1).max(60).default(15),
});

export const dashboardTools: ToolDefinition[] = [
  defineTool({
    name: 'get_dashboard',
    description:
      'Snapshot of the first `top_n` agents on the network for the given chain, with ' +
      'pricing info. Order mirrors the discovery feed - this is NOT a ranking by quality, ' +
      'reputation, or activity. Agent metadata is user-generated.',
    schema: GetDashboardSchema,
    async handler(ctx, input) {
      const agent = ctx.active();
      const network = input.network ?? agent.network;

      const agents = await agent.client.discovery.fetchAgents(network);

      // Filter by chain
      const filtered = agents.filter((a) =>
        a.cards.some((c) => (c.payment?.chain ?? 'solana') === input.chain),
      );

      // Build rows
      const rows = filtered
        .map((a) => {
          const mainCard = a.cards[0];
          const mainAsset = assetFromCardPayment(mainCard?.payment);
          const mainPrice = mainCard?.payment?.job_price;
          return {
            name: sanitizeField(a.name || mainCard?.name || 'unknown', 30),
            npub: a.npub,
            capabilities: (mainCard?.capabilities ?? []).join(', '),
            price: mainPrice ? formatAssetAmount(mainAsset, BigInt(mainPrice)) : 'free',
            cards_count: a.cards.length,
          };
        })
        .slice(0, input.top_n);

      if (rows.length === 0) {
        return textResult(`No agents found on ${network} (${input.chain}).`);
      }

      const header = `elisym Network Dashboard (${network}, ${input.chain})`;
      const table = rows
        .map((r, i) => `${i + 1}. ${r.name} | ${r.capabilities} | ${r.price} | ${r.npub}`)
        .join('\n');

      const { text } = sanitizeUntrusted(table, 'structured');
      return textResult(`${header}\n${'='.repeat(header.length)}\n\n${text}`);
    },
  }),
];
