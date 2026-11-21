import { createHash } from 'node:crypto';
import { ADMIN_PAGES_PREFIX } from '../admin/pages';
import type { GatewayRequest } from './gateway';
import { ASKR_SITE_URL, CATALOG_JSON_FILE, LLMS_TXT_FILE, STORE_DOCS_PREFIX } from './store-docs';
import { matchesEtag } from './store-docs-http';

/** This host's own `llms.txt`, for AI agents that open the server's root. */
export const SERVER_LLMS_TXT_PATH = `/${LLMS_TXT_FILE}`;
/** What browsers and proxies may cache it for: it changes only with a release. */
export const SERVER_LLMS_TXT_MAX_AGE_SECS = 3_600;

const DOCS_BASE = 'https://docs.elisym.network';
/** The docs pages it links, by path under the docs site (a test keeps each a real page). */
export const SERVER_LLMS_DOCS_PAGES = {
  aiAgents: '/askr/ai-agents',
  agentSetup: '/askr/agent-setup',
  admin: '/askr/admin',
  embed: '/askr/embed',
  overview: '/askr/overview',
} as const;
const DOCS_LLMS_TXT_URL = `${DOCS_BASE}/llms.txt`;
export const CLI_COMMAND = 'npx -y @elisym/cli@latest askr <command>';
const ETAG_HEX_CHARS = 32;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'x-content-type-options': 'nosniff',
};

function docsUrl(path: string): string {
  return `${DOCS_BASE}${path}`;
}

/** The server's `llms.txt` (Markdown, llms.txt form), with every address under `publicBase`. */
export function renderServerLlmsTxt(publicBase: string): string {
  const storeFile = (file: string) => `${publicBase}${STORE_DOCS_PREFIX}npub1.../${file}`;
  return [
    '# Askr server',
    '',
    `> This host runs the server of Askr, a shopping assistant for online stores: its chat widget, the chat sessions and the merchant admin. Every active store also has two public, read-only files here for AI agents.`,
    '',
    "Nothing can be bought or ordered on this host: purchases happen on each store's own product pages. The store files are public: they need no sign-in, open no chat and cost the store none of its chat budget.",
    '',
    '## Store files for AI agents',
    '',
    `- \`${storeFile(LLMS_TXT_FILE)}\`: a store's products (title, price, link to its page) and its policies, as Markdown`,
    `- \`${storeFile(CATALOG_JSON_FILE)}\`: the same store, policies and products as JSON, for programs`,
    '',
    "Put the store's ID in place of `npub1...`: its npub or its 64-character hex key. A store that is not active answers 404. A store's own site may link both files from its own `/llms.txt`.",
    '',
    '## Widget and admin',
    '',
    `- [widget.js](${publicBase}/widget.js): the chat widget script a store's pages load`,
    `- [Admin](${publicBase}${ADMIN_PAGES_PREFIX}): where a merchant runs a store; a person signs in with the store's secret key. An AI agent sets up a store with the CLI instead: \`${CLI_COMMAND}\``,
    '',
    '## Learn more',
    '',
    `- [Askr](${ASKR_SITE_URL}/${LLMS_TXT_FILE}): what Askr is, its plans and prices, and how an AI agent sets it up for a store`,
    `- [AI agents and your store](${docsUrl(SERVER_LLMS_DOCS_PAGES.aiAgents)}): the store files in full`,
    `- [Set up with an AI agent](${docsUrl(SERVER_LLMS_DOCS_PAGES.agentSetup)}): the setup prompt and the CLI commands`,
    `- [The Askr admin](${docsUrl(SERVER_LLMS_DOCS_PAGES.admin)}): every section and field`,
    `- [Embed the widget](${docsUrl(SERVER_LLMS_DOCS_PAGES.embed)}): the script tag and its options`,
    `- [Askr overview](${docsUrl(SERVER_LLMS_DOCS_PAGES.overview)}): how Askr, its keys and the store data fit together`,
    `- [Docs for AI agents](${DOCS_LLMS_TXT_URL}): the whole documentation`,
    '',
  ].join('\n');
}

/**
 * `GET /llms.txt` on the server: a fixed file, rendered once at startup.
 * Undefined for any other path.
 */
export function createServerLlmsTxt(
  publicBase: string,
): (input: GatewayRequest) => Response | undefined {
  const body = renderServerLlmsTxt(publicBase);
  const etag = `"${createHash('sha256').update(body, 'utf8').digest('hex').slice(0, ETAG_HEX_CHARS)}"`;
  return ({ request }) => {
    if (new URL(request.url).pathname !== SERVER_LLMS_TXT_PATH) {
      return undefined;
    }
    const method = request.method;
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, 'access-control-max-age': '600' },
      });
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Only GET is served here.\n', {
        status: 405,
        headers: {
          ...CORS_HEADERS,
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          allow: 'GET, HEAD, OPTIONS',
        },
      });
    }
    const headers = {
      ...CORS_HEADERS,
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': `public, max-age=${SERVER_LLMS_TXT_MAX_AGE_SECS}`,
      etag,
    };
    if (matchesEtag(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
  };
}
