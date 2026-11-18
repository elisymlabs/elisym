import type { StoreConfig } from '@elisym/askr';
import { type ReactNode, useEffect, useState } from 'react';
import { EMBED_DOCS_URL } from '../constants';
import type { AdminClient } from '../lib/deps';
import {
  PLATFORM_HINTS,
  cspSources,
  elementSnippet,
  pinnedScriptSnippet,
  scriptSnippet,
} from '../lib/embed';
import { npubOf } from '../lib/signer';
import type { PinnedWidget, StoreView } from '../lib/types';
import { AddToCartHook } from './AddToCartHook';
import { CopyBlock } from './CopyBlock';
import { Notice } from './Notice';
import { Section } from './Section';

interface Props {
  api: Pick<AdminClient, 'pinnedWidget'>;
  view: Pick<StoreView, 'owner' | 'status'>;
  config: StoreConfig | undefined;
}

type PinnedLoad =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; widget: PinnedWidget };

/** Connector platforms whose own cart the chat fills by itself, on the shop's site. */
const NATIVE_CART_PLATFORMS: Readonly<Record<string, string>> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
};

/**
 * The platform whose own cart the widget fills, as it decides it from the
 * published settings (`native-cart.ts`): a Shopify or WooCommerce connector,
 * with or without the shop URL the cart needs.
 */
function nativeCartOf(
  config: StoreConfig,
): { platform: string; shopOrigin: string | undefined } | undefined {
  const { source } = config;
  const platform =
    source.kind === 'connector' && source.platform !== undefined
      ? NATIVE_CART_PLATFORMS[source.platform]
      : undefined;
  if (platform === undefined) {
    return undefined;
  }
  return {
    platform,
    shopOrigin: source.shopUrl === undefined ? undefined : new URL(source.shopUrl).origin,
  };
}

/**
 * The embed code, where to paste it and what add to cart needs; the chat
 * element, the pinned version and the CSP sources under Advanced (6).
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

  // What the widget shows on a store that is not active (its client and the gateway).
  let statusNotice: ReactNode = null;
  if (view.status === 'pending') {
    statusNotice = (
      <Notice tone="info">
        Your store is not active yet. Until it is, the chat says &quot;The assistant is not set up
        for this store&quot;. You can add the code now; once your store is activated, reload your
        site&apos;s page and the chat answers.
      </Notice>
    );
  } else if (view.status === 'suspended') {
    statusNotice = (
      <Notice tone="warn">
        Your store is suspended, so the chat says the assistant is unavailable. Contact the Askr
        operator to reactivate it.
      </Notice>
    );
  }

  let cart: ReactNode;
  const native = config === undefined ? undefined : nativeCartOf(config);
  if (config === undefined) {
    cart = (
      <p className="text-14 text-text-2">
        Once your settings are published, this says whether the cards get an add to cart button.
      </p>
    );
  } else if (native !== undefined && native.shopOrigin === undefined) {
    cart = (
      <Notice tone="warn">
        Your products come from your {native.platform} shop, but your settings do not name its
        address. Add it in Settings, and the cards on your shop&apos;s site get an add to cart
        button that fills its cart.
      </Notice>
    );
  } else if (native !== undefined) {
    const otherSites = config.origins.filter((origin) => origin !== native.shopOrigin);
    cart = (
      <>
        <Notice tone="info">
          Your products come from your {native.platform} shop, so on your shop&apos;s own site (
          {native.shopOrigin}) the cards get an add to cart button that fills its cart, once the
          shopper has picked the size, color and so on. Nothing to add. A product whose choice the
          shop leaves open opens its page instead. A hook of your own, if your pages have one, takes
          the cart&apos;s place.
        </Notice>
        {otherSites.length === 0 ? null : (
          <details className="disclosure">
            <summary>
              Your other sites ({otherSites.join(', ')}) get no button: a hook for them
            </summary>
            <div className="mt-8 flex flex-col gap-8">
              <AddToCartHook />
            </div>
          </details>
        )}
      </>
    );
  } else {
    cart = (
      <>
        <p className="text-14 text-text-2">
          The cards get an add to cart button only from a Shopify or WooCommerce connector, or when
          your site says how to add a product. If yours can, have your developer fill in this hook
          on every page with the chat.
        </p>
        <AddToCartHook />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-32">
      <Section
        title="Add the chat to your site"
        description="Paste this before the closing body tag on every page that should show the chat. It always loads the current version, so fixes reach your site within minutes."
      >
        {statusNotice}
        <CopyBlock label="Embed code" text={scriptSnippet(npub)} />
        <p className="text-13 text-text-2">
          The chat answers only on your allowed sites
          {config === undefined ? '' : `: ${config.origins.join(', ')}`}. Add data-theme="light" or
          data-theme="dark" to the script tag to fix its colors.
        </p>
      </Section>
      <Section title="Where to paste it" flush>
        <ul className="rows text-13 flex flex-col" aria-label="Where to paste it">
          {PLATFORM_HINTS.map((hint) => (
            <li
              key={hint.platform}
              className="flex flex-col gap-2 px-20 py-12 sm:flex-row sm:gap-24"
            >
              <span className="text-text font-medium sm:w-180 sm:shrink-0">{hint.platform}:</span>{' '}
              <span className="text-text-2">{hint.where}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title="Add to cart"
        description="Each product card links to its page. Whether it also has an add to cart button depends on where your products come from."
      >
        {cart}
        <a
          className="text-13 text-text-2 hover:text-text self-start underline underline-offset-2"
          href={EMBED_DOCS_URL}
          target="_blank"
          rel="noreferrer"
        >
          More on add to cart in the guide
        </a>
      </Section>
      <details className="disclosure">
        <summary className="text-15 font-semibold">Advanced</summary>
        <div className="mt-20 flex flex-col gap-32">
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
            description="If your site sends a Content-Security-Policy header, add these sources to it. An add to cart hook written inline needs a nonce or hash of its own, or a file of its own."
            flush
          >
            <div className="overflow-x-auto">
              <table className="data-table text-13">
                <thead>
                  <tr>
                    <th>Directive</th>
                    <th>Sources</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {cspSources().map((source) => (
                    <tr key={source.directive} className="align-top">
                      <td className="font-mono whitespace-nowrap">{source.directive}</td>
                      <td className="font-mono break-all">{source.sources.join(' ')}</td>
                      <td className="text-text-2">{source.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </details>
    </div>
  );
}
