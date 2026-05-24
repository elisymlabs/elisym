import { formatAssetAmount } from '@elisym/sdk';
import type { Agent } from '@elisym/sdk';
import { z } from 'zod';
import { sanitizeField, sanitizeUntrusted } from '../sanitize.js';
import { assetFromCardPayment } from '../utils.js';
import type { ToolDefinition } from './types.js';
import { defineTool, textResult } from './types.js';

/** Per-capability-tag display cap before joining into the dashboard row. */
const MAX_CAPABILITY_TAG_LEN = 64;

/**
 * Resolve a promise or reject with a clear timeout error after `timeoutMs`.
 * `fetchAgents` does not accept an AbortSignal, so we bound it with a race; the
 * underlying query still runs to completion but the caller stops waiting.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`dashboard query timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

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

      // Honor the advertised `timeout_secs`: bound the discovery fetch so a slow
      // or unresponsive relay set cannot hang the tool call indefinitely.
      let agents: Agent[];
      try {
        agents = await withTimeout(
          agent.client.discovery.fetchAgents(network),
          input.timeout_secs * 1000,
        );
      } catch (e) {
        return textResult(e instanceof Error ? e.message : String(e));
      }

      // Filter by chain
      const filtered = agents.filter((candidate) =>
        candidate.cards.some((card) => (card.payment?.chain ?? 'solana') === input.chain),
      );

      // Build rows
      const rows = filtered
        .map((candidate) => {
          const mainCard = candidate.cards[0];
          const mainAsset = assetFromCardPayment(mainCard?.payment);
          const mainPrice = mainCard?.payment?.job_price;
          const capabilities = (mainCard?.capabilities ?? [])
            .map((capability) => sanitizeField(capability, MAX_CAPABILITY_TAG_LEN))
            .join(', ');
          return {
            name: sanitizeField(candidate.name || mainCard?.name || 'unknown', 30),
            npub: candidate.npub,
            capabilities,
            price: mainPrice ? formatAssetAmount(mainAsset, BigInt(mainPrice)) : 'free',
            cards_count: candidate.cards.length,
          };
        })
        .slice(0, input.top_n);

      if (rows.length === 0) {
        return textResult(`No agents found on ${network} (${input.chain}).`);
      }

      const header = `elisym Network Dashboard (${network}, ${input.chain})`;
      const table = rows
        .map(
          (row, index) =>
            `${index + 1}. ${row.name} | ${row.capabilities} | ${row.price} | ${row.npub}`,
        )
        .join('\n');

      const { text } = sanitizeUntrusted(table, 'structured');
      return textResult(`${header}\n${'='.repeat(header.length)}\n\n${text}`);
    },
  }),
];
