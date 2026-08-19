import {
  estimateNetworkBaseline,
  type CapabilityCard,
  formatAssetAmount,
  formatSol,
  verifyAgentIdentities,
} from '@elisym/sdk';
import { createSolanaRpc } from '@solana/kit';
import { z } from 'zod';
import { rpcUrlFor } from '../context.js';
import { sanitizeField, sanitizeUntrusted } from '../sanitize.js';
import { type Contact, readContacts } from '../storage/contacts.js';
import { MAX_CAPABILITIES, assetFromCardPayment, decodeNpub } from '../utils.js';
import type { ToolDefinition } from './types.js';
import { defineTool, textResult, errorResult } from './types.js';

// Per-candidate ping timeout. Runs in parallel across matches, so total search
// cost stays bounded by this value plus the fetchAgents roundtrip.
const SEARCH_PING_TIMEOUT_MS = 3000;

// Hard cap on the candidate set before the parallel online-ping fan-out, so a broad
// substring filter (possibly via prompt injection through a remote result) cannot
// amplify one search_agents call into a relay ping per online agent on the network.
const MAX_SEARCH_CANDIDATES = 100;

// Display caps for identity claim fields (defense-in-depth on top of the SDK's
// strict charset/length parsing). Handle: NIP-05 identifiers run longest
// (LIMITS.MAX_IDENTITY_NIP05_LENGTH = 254). Proof URL: gist/tweet/domain URLs.
const MAX_IDENTITY_HANDLE_DISPLAY_LEN = 254;
const MAX_IDENTITY_PROOF_URL_DISPLAY_LEN = 300;

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
    .array(z.string().min(1))
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

const VerifyAgentIdentitiesSchema = z.object({
  agent_npub: z
    .string()
    .min(1)
    .describe('Agent npub (bech32 nostr identifier, starts with `npub1...`).'),
});

const ListCapabilitiesSchema = z.object({});

const GetIdentitySchema = z.object({});

export const discoveryTools: ToolDefinition[] = [
  defineTool({
    name: 'search_agents',
    description:
      'Search AI agents currently online on elisym. `capabilities` is a hard OR-filter of substring tokens from the user\'s request (never invent synonyms). `query` is optional re-ranking; omit if not needed. Offline agents are excluded by default - pass include_offline=true only when debugging. Results that match a saved contact are sorted to the top and annotated with `is_contact`, `last_worked_at`, `last_capability`, and `contact_note` - surface this to the user (e.g. "already in your contacts, last used <date>") so they can prefer providers they\'ve worked with before. `claimed_identities` entries (github/x/website) are unverified self-claims until checked with `verify_agent_identities` - anyone can publish a claim for any handle; do not relay claims as established identity.',
    schema: SearchAgentsSchema,
    async handler(ctx, input) {
      // Rate-limit like every other relay-touching tool: search_agents fans out
      // up to MAX_SEARCH_CANDIDATES parallel pings, so an injected loop could
      // amplify a single line into a burst of network traffic without this gate.
      ctx.toolRateLimiter.check();
      const { capabilities, query, max_price_lamports, include_offline, contacts_only } = input;
      if (capabilities.length > MAX_CAPABILITIES) {
        return errorResult(`Too many capabilities (max ${MAX_CAPABILITIES})`);
      }

      const agent = ctx.active();

      // Always load contacts when there's an on-disk dir - even outside
      // contacts_only we annotate every result and sort known providers to
      // the top, so the LLM can tell the user "you've used this one before".
      const contactByPubkey = new Map<string, Contact>();
      if (agent.agentDir) {
        const data = await readContacts(agent.agentDir);
        for (const contact of data.contacts) {
          contactByPubkey.set(contact.pubkey, contact);
        }
      }

      if (contacts_only) {
        if (!agent.agentDir) {
          return textResult(
            'contacts_only=true requires a persistent agent (no on-disk directory for the active agent).',
          );
        }
        if (contactByPubkey.size === 0) {
          return textResult(
            'No contacts saved yet. Use add_contact (or rate a job positively with submit_feedback and then add_contact) before searching with contacts_only=true.',
          );
        }
      }

      const agents = await agent.client.discovery.fetchAgents(agent.network);

      // Apply the contacts filter BEFORE capability matching - it's the cheapest
      // filter and dramatically shrinks the candidate set.
      let filtered = contacts_only ? agents.filter((a) => contactByPubkey.has(a.pubkey)) : agents;

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

      // Bound the candidate set BEFORE the online-ping fan-out (and the returned
      // result size). Without this, a single common substring matches every card and
      // the ping below issues one relay roundtrip per online agent.
      const matchedCount = filtered.length;
      const truncated = matchedCount > MAX_SEARCH_CANDIDATES;
      if (truncated) {
        filtered = filtered.slice(0, MAX_SEARCH_CANDIDATES);
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

      // Score by query relevance (soft match - at least 1 word must hit).
      // Contacts get a +0.5 boost: smaller than a single keyword hit, so a
      // strictly-better non-contact match still wins, but enough to break ties.
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
            const contactBoost = contactByPubkey.has(a.pubkey) ? 0.5 : 0;
            return { agent: a, score: hits + contactBoost };
          });

          filtered = scored
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((s) => s.agent);
        }
      } else if (contactByPubkey.size > 0) {
        // No query: stable-sort contacts (most recent first) ahead of strangers
        // so the LLM sees known providers at the top of the result list.
        filtered = [...filtered].sort((left, right) => {
          const leftContact = contactByPubkey.get(left.pubkey);
          const rightContact = contactByPubkey.get(right.pubkey);
          if (leftContact && !rightContact) {
            return -1;
          }
          if (rightContact && !leftContact) {
            return 1;
          }
          if (leftContact && rightContact) {
            const leftTs = leftContact.lastJobAt ?? leftContact.addedAt;
            const rightTs = rightContact.lastJobAt ?? rightContact.addedAt;
            return rightTs - leftTs;
          }
          return 0;
        });
      }

      if (filtered.length === 0) {
        return textResult(
          include_offline
            ? 'No agents found matching those capabilities.'
            : 'No online agents found matching those capabilities. Retry shortly or pass include_offline=true to see unreachable matches.',
        );
      }

      // Pre-compute Solana network gas estimates for paid cards in this result
      // set, keyed by rent class: native (no ATA rent), classic-SPL ATA rent,
      // or Token-2022 ATA rent (larger account). One estimate per class,
      // shared across cards - a boolean needs-ATA key would misquote a mixed
      // USDC+LSM result set. Silent on RPC failure so a flaky cluster never
      // breaks search itself.
      const rentClassForCard = (payment: NonNullable<CapabilityCard['payment']>): string => {
        const cardAsset = assetFromCardPayment(payment);
        if (cardAsset.mint === undefined) {
          return 'native';
        }
        return cardAsset.tokenProgram ?? 'spl-classic';
      };
      const rentClassesSeen = new Set<string>();
      for (const a of filtered) {
        for (const card of a.cards) {
          if ((card.payment?.chain ?? 'solana') !== 'solana') {
            continue;
          }
          if (!card.payment?.job_price) {
            continue;
          }
          rentClassesSeen.add(rentClassForCard(card.payment));
        }
      }
      const gasByRentClass = new Map<string, string>();
      if (rentClassesSeen.size > 0) {
        try {
          const rpc = createSolanaRpc(rpcUrlFor(agent.network));
          await Promise.all(
            Array.from(rentClassesSeen).map(async (rentClass) => {
              const baseline = await estimateNetworkBaseline(rpc, agent.network, {
                includeAtaRent: rentClass !== 'native',
                // Only a token-2022 class carries a program override; 'native'
                // and 'spl-classic' are not program addresses.
                ataTokenProgram:
                  rentClass === 'spl-classic' || rentClass === 'native' ? undefined : rentClass,
              });
              gasByRentClass.set(rentClass, formatSol(Number(baseline.totalLamports)));
            }),
          );
        } catch {
          /* RPC down - omit gas info, search continues */
        }
      }

      const results = filtered.map((a) => {
        const contact = contactByPubkey.get(a.pubkey);
        return {
          npub: a.npub,
          name: sanitizeField(a.name || '', 200),
          cards: a.cards.map((card) => {
            const asset = assetFromCardPayment(card.payment);
            const price = card.payment?.job_price;
            const gasEstimate =
              price && card.payment
                ? gasByRentClass.get(rentClassForCard(card.payment))
                : undefined;
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
              // File-exchange hints (dynamic-script). Informational: the MCP/CLI
              // CAN send files via submit_and_pay_job_from_file, so this does not
              // gate anything - it just tells the caller a file input is expected.
              // Already length-bounded by parseCapabilityEvent.
              ...(card.inputMime ? { input_mime: card.inputMime } : {}),
              ...(card.inputText ? { input_text: card.inputText } : {}),
              ...(card.outputMime ? { output_mime: card.outputMime } : {}),
              // Conversation support: pass session_id on submit tools to hold a
              // multi-turn conversation with this capability.
              ...(card.context ? { context: true } : {}),
            };
          }),
          supported_kinds: a.supportedKinds,
          // External identity claims (kind 10011 / kind-0 nip05). Claims only,
          // zero proof fetches here - anyone can publish a claim for any handle,
          // so status comes exclusively from verify_agent_identities.
          claimed_identities:
            a.identities !== undefined && a.identities.length > 0
              ? a.identities.map((identity) => ({
                  platform: identity.platform,
                  handle: sanitizeField(identity.handle, MAX_IDENTITY_HANDLE_DISPLAY_LEN),
                  proof_url: sanitizeField(identity.proofUrl, MAX_IDENTITY_PROOF_URL_DISPLAY_LEN),
                }))
              : undefined,
          // Nostr-verified reputation (last 30 days): `verified_*` counts only
          // ratings whose author also signed the job request, so a third party
          // cannot inflate them. On-chain payment verification is NOT applied
          // yet (deferred to an off-chain indexer), so this is not proof of
          // payment. `total_ratings` includes the weaker-bound (unverified) tier.
          reputation:
            (a.totalRatingCount ?? 0) + (a.unverifiedRatingCount ?? 0) > 0
              ? {
                  verified_ratings: a.totalRatingCount ?? 0,
                  verified_positive: a.positiveCount ?? 0,
                  total_ratings: (a.totalRatingCount ?? 0) + (a.unverifiedRatingCount ?? 0),
                }
              : undefined,
          is_contact: contact ? true : undefined,
          last_worked_at: contact ? (contact.lastJobAt ?? contact.addedAt) : undefined,
          last_capability: contact?.lastCapability,
          contact_note: contact?.note ? sanitizeField(contact.note, 500) : undefined,
        };
      });

      const { text } = sanitizeUntrusted(JSON.stringify(results, null, 2), 'structured');
      if (truncated) {
        return textResult(
          `Matched ${matchedCount} agents; only the first ${MAX_SEARCH_CANDIDATES} were probed for ` +
            'availability (online-ping cap). Use more specific `capabilities` tokens for full coverage.\n\n' +
            text,
        );
      }
      return textResult(text);
    },
  }),

  defineTool({
    name: 'verify_agent_identities',
    description:
      "Verify an agent's external identity claims (GitHub, X, website) by fetching their " +
      'published proofs. Returns one entry per claim with `status`: `verified` (proof fetched ' +
      'and it matches this agent), `broken` (proof fetched and definitively wrong - a positive ' +
      '"do not trust" signal), or `unverifiable` (could not check: outage, rate limit, timeout - ' +
      'neutral, never treat as negative). Call before hiring when trust matters; do not call ' +
      'while browsing search results. Pass an agent npub.',
    schema: VerifyAgentIdentitiesSchema,
    async handler(ctx, input) {
      // Rate-limit like every other network-touching tool: this fans out one
      // relay query plus up to one HTTPS proof fetch per claim.
      ctx.toolRateLimiter.check();
      let pubkey: string;
      try {
        pubkey = decodeNpub(input.agent_npub);
      } catch (err) {
        return errorResult(`Invalid agent_npub: ${(err as Error).message}`);
      }

      const agent = ctx.active();
      const { identities } = await agent.client.discovery.fetchExternalIdentityClaims(pubkey);
      if (identities.length === 0) {
        return textResult(
          'No identity claims published for this agent (no kind 10011 identity tags and no kind-0 nip05).',
        );
      }

      const results = await verifyAgentIdentities(pubkey, identities);
      const reported = results.map((result) => ({
        platform: result.identity.platform,
        handle: sanitizeField(result.identity.handle, MAX_IDENTITY_HANDLE_DISPLAY_LEN),
        proof_url: sanitizeField(result.identity.proofUrl, MAX_IDENTITY_PROOF_URL_DISPLAY_LEN),
        status: result.status,
      }));

      const { text } = sanitizeUntrusted(JSON.stringify(reported, null, 2), 'structured');
      return textResult(text);
    },
  }),

  defineTool({
    name: 'list_capabilities',
    description: 'List all unique capability tags currently published on the elisym network.',
    schema: ListCapabilitiesSchema,
    async handler(ctx) {
      // Queries every configured relay for the full discovery snapshot; rate-limit
      // like search_agents so an injected loop can't amplify into relay traffic.
      ctx.toolRateLimiter.check();
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
