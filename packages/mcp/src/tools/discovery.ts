import { estimateNetworkBaseline, formatAssetAmount, formatSol } from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import { z } from 'zod';
import { rpcUrlFor } from '../context.js';
import { sanitizeField, sanitizeUntrusted } from '../sanitize.js';
import { readContacts } from '../storage/contacts.js';
import { MAX_CAPABILITIES, assetFromCardPayment } from '../utils.js';
import type { ToolDefinition } from './types.js';
import { defineTool, textResult, errorResult } from './types.js';

// Per-candidate ping timeout. Runs in parallel across matches, so total search
// cost stays bounded by this value plus the fetchAgents roundtrip.
const SEARCH_PING_TIMEOUT_MS = 3000;

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
  'can',
  'could',
  'of',
  'in',
  'to',
  'for',
  'with',
  'on',
  'at',
  'from',
  'by',
  'about',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'each',
  'every',
  'all',
  'any',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'only',
  'own',
  'same',
  'than',
  'too',
  'very',
  'just',
  'that',
  'this',
  'these',
  'those',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'it',
  'its',
  'they',
  'them',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'how',
  'find',
  'get',
  'search',
  'show',
  'list',
  'give',
  'want',
  'need',
  'looking',
  'agent',
  'agents',
  'sell',
  'sells',
  'selling',
  'buy',
  'buying',
  'provide',
  'provides',
]);

const SearchAgentsSchema = z.object({
  capabilities: z
    .array(z.string())
    .min(1)
    .describe('OR-matched substring filter on agent names, descriptions, and capability tags.'),
  query: z
    .string()
    .optional()
    .describe('Optional secondary scoring for re-ranking. Omit when you have precise tokens.'),
  max_price_lamports: z.number().int().optional(),
  include_offline: z
    .boolean()
    .default(false)
    .describe(
      'If true, skip the live online check and return agents regardless of reachability. Default: false - only currently-online agents are returned.',
    ),
  contacts_only: z
    .boolean()
    .default(false)
    .describe(
      "If true, restrict results to providers saved in the active agent's " +
        '.contacts.json. Each returned item gains a `last_worked_at` field.',
    ),
});

const ListCapabilitiesSchema = z.object({});

const GetIdentitySchema = z.object({});

export const discoveryTools: ToolDefinition[] = [
  defineTool({
    name: 'search_agents',
    description:
      "Search AI agents currently online on elisym. `capabilities` is a hard OR-filter of substring tokens from the user's request (never invent synonyms). `query` is optional re-ranking; omit if not needed. Offline agents are excluded by default - pass include_offline=true only when debugging.",
    schema: SearchAgentsSchema,
    async handler(ctx, input) {
      const { capabilities, query, max_price_lamports, include_offline, contacts_only } = input;
      if (capabilities.length > MAX_CAPABILITIES) {
        return errorResult(`Too many capabilities (max ${MAX_CAPABILITIES})`);
      }

      const agent = ctx.active();

      // Contacts gate runs before the network roundtrip when possible: an empty
      // .contacts.json with `contacts_only` requested can be answered immediately.
      let lastWorkedAtByPubkey = new Map<string, number>();
      if (contacts_only) {
        if (!agent.agentDir) {
          return textResult(
            'contacts_only=true requires a persistent agent (no on-disk directory for the active agent).',
          );
        }
        const data = await readContacts(agent.agentDir);
        if (data.contacts.length === 0) {
          return textResult(
            'No contacts saved yet. Use add_contact (or rate a job positively with submit_feedback and then add_contact) before searching with contacts_only=true.',
          );
        }
        lastWorkedAtByPubkey = new Map(
          data.contacts.map((contact) => [contact.pubkey, contact.lastJobAt ?? contact.addedAt]),
        );
      }

      const agents = await agent.client.discovery.fetchAgents(agent.network);

      // Apply the contacts filter BEFORE capability matching - it's the cheapest
      // filter and dramatically shrinks the candidate set.
      let filtered = contacts_only
        ? agents.filter((a) => lastWorkedAtByPubkey.has(a.pubkey))
        : agents;

      // Filter by capabilities (OR match)
      filtered = filtered.filter((a) =>
        a.cards.some((card) =>
          capabilities.some(
            (cap: string) =>
              card.capabilities?.some((c: string) => c.toLowerCase().includes(cap.toLowerCase())) ||
              card.name?.toLowerCase().includes(cap.toLowerCase()) ||
              card.description?.toLowerCase().includes(cap.toLowerCase()),
          ),
        ),
      );

      // Apply price filter
      if (max_price_lamports !== undefined) {
        filtered = filtered.filter((a) =>
          a.cards.some(
            (card) => !card.payment?.job_price || card.payment.job_price <= max_price_lamports,
          ),
        );
      }

      // Online gate: parallel live ping across all candidates. The 30s pong cache
      // in PingService means a follow-up submit_and_pay_job / buy_capability on
      // any returned agent re-uses this probe without another relay roundtrip.
      if (!include_offline && filtered.length > 0) {
        const probes = await Promise.allSettled(
          filtered.map((candidate) =>
            agent.client.ping.pingAgent(candidate.pubkey, SEARCH_PING_TIMEOUT_MS),
          ),
        );
        const survivors: typeof filtered = [];
        filtered.forEach((candidate, index) => {
          const probe = probes[index];
          if (probe?.status === 'fulfilled' && probe.value.online) {
            survivors.push(candidate);
          }
        });
        filtered = survivors;
      }

      // Score by query relevance (soft match - at least 1 word must hit)
      if (query) {
        // non-ASCII queries bypass stop-word filtering (English-only stop list).
        // eslint-disable-next-line no-control-regex
        const isAscii = /^[\u0000-\u007F]*$/.test(query);
        const words = query
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 1 && (!isAscii || !STOP_WORDS.has(w)));

        if (words.length > 0) {
          const scored = filtered.map((a) => {
            let hits = 0;
            for (const w of words) {
              if (
                a.name?.toLowerCase().includes(w) ||
                a.cards.some(
                  (c) =>
                    c.name?.toLowerCase().includes(w) ||
                    c.description?.toLowerCase().includes(w) ||
                    c.capabilities?.some((cap: string) => cap.toLowerCase().includes(w)),
                )
              ) {
                hits++;
              }
            }
            return { agent: a, score: hits };
          });

          filtered = scored
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((s) => s.agent);
        }
      }

      if (filtered.length === 0) {
        return textResult(
          include_offline
            ? 'No agents found matching those capabilities.'
            : 'No online agents found matching those capabilities. Retry shortly or pass include_offline=true to see unreachable matches.',
        );
      }

      // Pre-compute Solana network gas estimates for paid cards in this result
      // set. Two possible asset shapes (with/without ATA rent for USDC), each
      // estimated at most once and shared across cards. Silent on RPC failure
      // so a flaky cluster never breaks search itself.
      const needsAtaSeen = new Set<boolean>();
      for (const a of filtered) {
        for (const card of a.cards) {
          if ((card.payment?.chain ?? 'solana') !== 'solana') {
            continue;
          }
          if (!card.payment?.job_price) {
            continue;
          }
          needsAtaSeen.add(assetFromCardPayment(card.payment).mint !== undefined);
        }
      }
      const gasByAtaNeed = new Map<boolean, string>();
      if (needsAtaSeen.size > 0) {
        try {
          const rpc = createSolanaRpc(rpcUrlFor(agent.network));
          await Promise.all(
            Array.from(needsAtaSeen).map(async (needsAta) => {
              const baseline = await estimateNetworkBaseline(rpc, { includeAtaRent: needsAta });
              gasByAtaNeed.set(needsAta, formatSol(Number(baseline.totalLamports)));
            }),
          );
        } catch {
          /* RPC down - omit gas info, search continues */
        }
      }

      const results = filtered.map((a) => ({
        npub: a.npub,
        name: sanitizeField(a.name || '', 200),
        cards: a.cards.map((card) => {
          const asset = assetFromCardPayment(card.payment);
          const price = card.payment?.job_price;
          const gasEstimate = price ? gasByAtaNeed.get(asset.mint !== undefined) : undefined;
          return {
            name: sanitizeField(card.name || '', 200),
            description: sanitizeField(card.description || '', 500),
            capabilities: card.capabilities,
            job_price_subunits: price,
            price_display: price ? formatAssetAmount(asset, BigInt(price)) : 'free',
            asset_token: asset.token,
            asset_symbol: asset.symbol,
            asset_mint: asset.mint,
            chain: card.payment?.chain,
            network: card.payment?.network,
            network_fee_estimate_sol: gasEstimate,
          };
        }),
        supported_kinds: a.supportedKinds,
        last_worked_at: contacts_only ? lastWorkedAtByPubkey.get(a.pubkey) : undefined,
      }));

      const { text } = sanitizeUntrusted(JSON.stringify(results, null, 2), 'structured');
      return textResult(text);
    },
  }),

  defineTool({
    name: 'list_capabilities',
    description: 'List all unique capability tags currently published on the elisym network.',
    schema: ListCapabilitiesSchema,
    async handler(ctx) {
      const agent = ctx.active();
      const agents = await agent.client.discovery.fetchAgents(agent.network);

      const caps = new Set<string>();
      for (const a of agents) {
        for (const card of a.cards) {
          for (const cap of card.capabilities ?? []) {
            if (cap !== 'elisym') {
              caps.add(sanitizeField(cap, 200));
            }
          }
        }
      }

      const sorted = [...caps].sort();
      const { text } = sanitizeUntrusted(JSON.stringify(sorted, null, 2), 'structured');
      return textResult(`Found ${sorted.length} unique capabilities on the network:\n${text}`);
    },
  }),

  defineTool({
    name: 'get_identity',
    description:
      "Get this agent's identity - public key (npub), name, description, and capabilities.",
    schema: GetIdentitySchema,
    async handler(ctx) {
      const agent = ctx.active();
      return textResult(
        JSON.stringify(
          {
            npub: agent.identity.npub,
            name: agent.name,
            solana_address: agent.solanaKeypair?.publicKey,
          },
          null,
          2,
        ),
      );
    },
  }),
];
