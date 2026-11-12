import { ASKR_API_BASE, ASKR_RELAYS } from '@elisym/askr';
import { WIDGET_ELEMENT, WIDGET_SCRIPT_URL } from '../constants';

/** The one-line embed: the script mounts the chat for the store it names. */
export function scriptSnippet(npub: string): string {
  return `<script src="${WIDGET_SCRIPT_URL}" data-store="${npub}" async></script>`;
}

/** The element form, for a host that places the chat itself. */
export function elementSnippet(npub: string): string {
  return `<${WIDGET_ELEMENT} store="${npub}"></${WIDGET_ELEMENT}>\n<script src="${WIDGET_SCRIPT_URL}" async></script>`;
}

export interface CspSource {
  directive: string;
  sources: string[];
  why: string;
}

/** The sources a site with a Content-Security-Policy must allow (6). */
export function cspSources(): CspSource[] {
  // The widget reads and writes only the compiled-in Askr relay (K20).
  const relayOrigins = ASKR_RELAYS.map((relay) => new URL(relay).origin);
  return [
    { directive: 'script-src', sources: [ASKR_API_BASE], why: 'loads widget.js' },
    {
      directive: 'connect-src',
      sources: [ASKR_API_BASE, ...relayOrigins],
      why: 'session tickets from the API, the chat over the relay',
    },
    {
      directive: 'img-src',
      sources: ['https:'],
      why: 'product images and the avatar live on any https host',
    },
  ];
}
