import { nip19 } from 'nostr-tools';
import { z } from 'zod';
import { sanitizeField, sanitizeUntrusted } from '../sanitize.js';
import { MAX_CAPABILITIES, formatSolShort } from '../utils.js';
import type { ToolDefinition } from './types.js';
import { defineTool, textResult, errorResult } from './types.js';

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
  // rename in description so it's obvious we're using a heuristic freshness signal,
  // not a live reachability probe.
  recently_active_only: z
    .boolean()
    .default(true)
    .describe(
      'If true, only return agents with job activity in the last hour. Not a liveness probe.',
    ),
});

const ListCapabilitiesSchema = z.object({});

const GetIdentitySchema = z.object({});

const PingAgentSchema = z.object({
  agent_npub: z.string(),
  // single source of truth for the default.
  timeout_secs: z.number().int().min(1).max(600).default(15),
});

export const discoveryTools: ToolDefinition[] = [
  defineTool({
    name: 'search_agents',
    // previous description was ~90 tokens and was truncated by some MCP clients.
    // Keep the operational rules short; schema `.describe()` fields carry the detail.
    description:
      "Search AI agents. `capabilities` is a hard OR-filter of substring tokens from the user's request (never invent synonyms). `query` is optional re-ranking; omit if not needed.",
    schema: SearchAgentsSchema,
    async handler(ctx, input) {
      const { capabilities, query, max_price_lamports, recently_active_only } = input;
      if (capabilities.length > MAX_CAPABILITIES) {
        return errorResult(`Too many capabilities (max ${MAX_CAPABILITIES})`);
      }

      const agent = ctx.active();
      const agents = await agent.client.discovery.fetchAgents(agent.network);

      // Filter by capabilities (OR match)
      let filtered = agents.filter((a) =>
        a.cards.some((card) =>
          capabilities.some(
            (cap: string) =>
              card.capabilities?.some((c: string) => c.toLowerCase().includes(cap.toLowerCase())) ||
              card.name?.toLowerCase().includes(cap.toLowerCase()) ||
              card.description?.toLowerCase().includes(cap.toLowerCase()),
          ),
        ),
      );

      // "recently active" means the agent had job activity within the last hour,
      // not that it is currently reachable.
      if (recently_active_only) {
        const activeThreshold = Math.floor(Date.now() / 1000) - 60 * 60;
        filtered = filtered.filter((a) => a.lastSeen >= activeThreshold);
      }

      // Apply price filter
      if (max_price_lamports !== undefined) {
        filtered = filtered.filter((a) =>
          a.cards.some(
            (card) => !card.payment?.job_price || card.payment.job_price <= max_price_lamports,
          ),
        );
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
          recently_active_only
            ? 'No recently-active agents found matching those capabilities. Try with recently_active_only=false.'
            : 'No agents found matching those capabilities.',
        );
      }

      const results = filtered.map((a) => ({
        npub: a.npub,
        name: sanitizeField(a.name || '', 200),
        cards: a.cards.map((c) => ({
          name: sanitizeField(c.name || '', 200),
          description: sanitizeField(c.description || '', 500),
          capabilities: c.capabilities,
          job_price_lamports: c.payment?.job_price,
          price_display: c.payment?.job_price
            ? formatSolShort(BigInt(c.payment.job_price))
            : 'free',
          chain: c.payment?.chain,
          network: c.payment?.network,
        })),
        supported_kinds: a.supportedKinds,
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

  defineTool({
    name: 'ping_agent',
    description:
      "Ping an agent to check if it's online. Sends an encrypted heartbeat and waits for a pong.",
    schema: PingAgentSchema,
    async handler(ctx, input) {
      ctx.toolRateLimiter.check();
      const { agent_npub, timeout_secs } = input;
      const agent = ctx.active();

      // verify decoded type is npub.
      let pubkey: string;
      try {
        const decoded = nip19.decode(agent_npub);
        if (decoded.type !== 'npub') {
          return errorResult(`Expected npub, got ${decoded.type}`);
        }
        pubkey = decoded.data;
      } catch {
        return errorResult(`Invalid npub: ${agent_npub}`);
      }

      const timeoutMs = timeout_secs * 1000;
      const result = await agent.client.ping.pingAgent(pubkey, timeoutMs);

      return textResult(
        result.online
          ? `Agent ${agent_npub} is online.`
          : `Agent ${agent_npub} did not respond within ${timeout_secs}s.`,
      );
    },
  }),
];
