/**
 * `askr embed` (5.7): what goes on the merchant's site. The strings are the
 * admin's Embed tab's (`packages/askr-admin/src/lib/embed.ts`), kept here; a
 * test pins the snippet to the form in `packages/docs/pages/askr/embed.mdx`.
 */
import { WIDGET_ELEMENT, WIDGET_SCRIPT_URL } from './constants';
import { AskrExit, EXIT, type CommandOutcome } from './errors';
import { siteLlmsTxt, storeLlmsTxtUrl, writeSiteLlmsTxt } from './llms-txt';
import { readSigned } from './read';
import type { Askr, Session } from './session';
import { readView, useOwnerKey } from './store';

export function scriptSnippet(npub: string): string {
  return `<script src="${WIDGET_SCRIPT_URL}" data-store="${npub}" async></script>`;
}

export function elementSnippet(npub: string): string {
  return `<${WIDGET_ELEMENT} store="${npub}"></${WIDGET_ELEMENT}>\n<script src="${WIDGET_SCRIPT_URL}" async></script>`;
}

export function verificationMeta(npub: string): string {
  return `<meta name="askr-verification" content="${npub}">`;
}

function cspSources(askr: Askr): { directive: string; sources: string[] }[] {
  const relayOrigins = askr.ASKR_RELAYS.map((relay) => new URL(relay).origin);
  return [
    { directive: 'script-src', sources: [askr.ASKR_API_BASE] },
    { directive: 'connect-src', sources: [askr.ASKR_API_BASE, ...relayOrigins] },
    { directive: 'img-src', sources: ['https:'] },
  ];
}

const ADD_TO_CART = `<script>
  window.Askr = window.Askr || {};
  window.Askr.onAddToCart = function (detail) {
    // detail.d: the product ID; detail.sku: its SKU, if it has one;
    // detail.variant: the variant ID, when the shopper's pick determines one;
    // detail.options: { "Size": "M", ... }, whenever a choice is made.
    // Put the product in your cart here.
  };
</script>`;

const PLATFORM_HINTS: ReadonlyArray<{ platform: string; where: string }> = [
  {
    platform: 'Shopify',
    where:
      'Online Store, Themes, then Edit code in the theme menu: open theme.liquid and paste it before </body>.',
  },
  {
    platform: 'WordPress and WooCommerce',
    where: 'a plugin that adds code to every page (such as WPCode), set to the footer.',
  },
  {
    platform: 'Wix',
    where:
      'Settings, Custom Code, on all pages (a paid plan with a connected domain). Not the Embed HTML element: it runs on another address, where the chat does not answer.',
  },
  {
    platform: 'Squarespace',
    where:
      'Settings, Code Injection, in the footer (a Core plan or higher). A code block on a page shows the chat on that page only.',
  },
  {
    platform: 'Other site builders',
    where: 'the site-wide custom code setting, never a block on one page.',
  },
];

export interface EmbedOptions {
  /** Write the site's llms.txt there (or append the Askr part to the one there). */
  llmsTxt?: string;
}

export async function runEmbed(
  session: Session,
  options: EmbedOptions = {},
): Promise<CommandOutcome> {
  const key = await useOwnerKey(session);
  await readView(session);
  const { config } = await readSigned(session, key.owner, key.secretKey);
  if (config === undefined) {
    throw new AskrExit(EXIT.BAD_INPUT, 'no_settings', { hint: 'run askr init first' });
  }
  const written =
    options.llmsTxt === undefined
      ? undefined
      : await writeSiteLlmsTxt(options.llmsTxt, key.storeId, config.name);
  return {
    exitCode: EXIT.OK,
    output: {
      ok: true,
      storeId: key.storeId,
      snippet: scriptSnippet(key.storeId),
      element: elementSnippet(key.storeId),
      verificationMeta: verificationMeta(key.storeId),
      csp: cspSources(session.askr),
      platformHints: PLATFORM_HINTS,
      ...(config.source.kind === 'admin' ? { addToCart: ADD_TO_CART } : {}),
      llmsTxt: siteLlmsTxt(key.storeId, config.name),
      llmsTxtUrl: storeLlmsTxtUrl(key.storeId),
      ...(written === undefined ? {} : { llmsTxtFile: { path: options.llmsTxt, result: written } }),
    },
  };
}
