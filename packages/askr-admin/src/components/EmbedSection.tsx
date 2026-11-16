import type { StoreConfig } from '@elisym/askr';
import { useEffect, useState } from 'react';
import { EMBED_DOCS_URL } from '../constants';
import type { AdminClient } from '../lib/deps';
import {
  ADD_TO_CART_SNIPPET,
  PLATFORM_HINTS,
  cspSources,
  elementSnippet,
  pinnedScriptSnippet,
  scriptSnippet,
} from '../lib/embed';
import { npubOf } from '../lib/signer';
import type { PinnedWidget, StoreView } from '../lib/types';
import { CopyBlock } from './CopyBlock';
import { Notice } from './Notice';
import { Section } from './Section';

interface Props {
  api: Pick<AdminClient, 'pinnedWidget'>;
  view: Pick<StoreView, 'owner' | 'status' | 'connector'>;
  config: StoreConfig | undefined;
}

type PinnedLoad =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; widget: PinnedWidget };

/** Connector platforms whose own cart the chat fills by itself, on the shop's site. */
const NATIVE_CART_PLATFORMS: readonly string[] = ['shopify', 'woocommerce'];

/**
 * The embed code, where to paste it and what add to cart needs; the pinned
 * version and the CSP sources under Advanced, for the sites that need them (6).
 */
export function EmbedSection({ api, view, config }: Props) {
  const npub = npubOf(view.owner);
  const [pinned, setPinned] = useState<PinnedLoad>({ state: 'loading' });

  useEffect(() => {
    let current = true;
    api.pinnedWidget().then(
      (widget) => {
        if (current) {
          setPinned({ state: 'ready', widget });
        }
      },
      () => {
        if (current) {
          setPinned({ state: 'failed' });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  let pinnedContent;
  if (pinned.state === 'ready') {
    pinnedContent = (
      <CopyBlock label="Pinned embed code" text={pinnedScriptSnippet(npub, pinned.widget)} />
    );
  } else if (pinned.state === 'failed') {
    pinnedContent = (
      <Notice tone="warn">The pinned version could not be read. Refresh to try again.</Notice>
    );
  } else {
    pinnedContent = <p className="text-14 text-text-2">Reading the current version...</p>;
  }

  const platform = view.connector?.platform;
  const nativeCart = platform !== undefined && NATIVE_CART_PLATFORMS.includes(platform);

  return (
    <div className="flex flex-col gap-16">
      <Section
        title="Add the chat to your site"
        description="Paste this before the closing body tag on every page that should show the chat. It always loads the current version, so fixes reach your site within minutes."
      >
        {view.status === 'active' ? null : (
          <Notice tone="info">
            Your store is not active yet, so the chat says it is unavailable until it is. You can
            add the code now: it starts answering once your store is activated.
          </Notice>
        )}
        <CopyBlock label="Embed code" text={scriptSnippet(npub)} />
        <p className="text-13 text-text-2">
          The chat answers only on your allowed sites
          {config === undefined ? '' : `: ${config.origins.join(', ')}`}. Add data-theme="light" or
          data-theme="dark" to the script tag to fix its colors.
        </p>
        <ul className="text-13 text-text-2 flex flex-col gap-4">
          {PLATFORM_HINTS.map((hint) => (
            <li key={hint.platform}>
              <span className="text-text font-medium">{hint.platform}:</span> {hint.where}
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title="Add to cart"
        description="Each product card links to its page. Whether it also has an add to cart button depends on your site."
      >
        {nativeCart ? (
          <Notice tone="info">
            Your {platform === 'shopify' ? 'Shopify' : 'WooCommerce'} connector gives the cards an
            add to cart button that fills your shop&apos;s own cart, on your shop&apos;s site.
            Nothing to add.
          </Notice>
        ) : (
          <>
            <p className="text-14 text-text-2">
              Without a Shopify or WooCommerce connector, the cards have no add to cart button
              unless your site says how to add a product. If yours can, have your developer fill in
              this hook on every page with the chat:
            </p>
            <CopyBlock label="Add to cart hook" text={ADD_TO_CART_SNIPPET} />
          </>
        )}
        <a className="text-14 underline" href={EMBED_DOCS_URL} target="_blank" rel="noreferrer">
          More on add to cart in the guide
        </a>
      </Section>
      <details className="card flex flex-col gap-16">
        <summary className="text-15 cursor-pointer font-medium">Advanced</summary>
        <div className="mt-16 flex flex-col gap-16">
          <Section
            title="Place the chat element yourself"
            description="For a page that decides where the chat button goes."
          >
            <CopyBlock label="Chat element" text={elementSnippet(npub)} />
          </Section>
          <Section
            title="Pin one version"
            description="Only if your security policy requires it. This loads one exact version of the chat, and the browser runs it only if it matches its integrity hash, so it never changes under you. Fixes, security fixes included, and new features do not reach it: paste a newer snippet from here to update."
          >
            {pinnedContent}
          </Section>
          <Section
            title="Content Security Policy"
            description="If your site sends a Content-Security-Policy header, add these sources to it."
          >
            <table className="text-14 w-full">
              <tbody>
                {cspSources().map((source) => (
                  <tr key={source.directive} className="border-line border-t align-top">
                    <td className="py-6 pr-12 font-mono whitespace-nowrap">{source.directive}</td>
                    <td className="py-6 pr-12 font-mono break-all">{source.sources.join(' ')}</td>
                    <td className="text-text-2 py-6">{source.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </div>
      </details>
    </div>
  );
}
