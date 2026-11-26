import type { ReactNode } from 'react';
import { domainGuide } from '../lib/embed';
import type { StoreView } from '../lib/types';
import { CodeBlock } from './CodeBlock';
import { Notice } from './Notice';

interface Props {
  view: StoreView;
  nip05: string | undefined;
}

export const NO_DOMAIN =
  'Your store has no domain, so it is level C: it sells on any page, with no trust chip. For level A, set its address (nip05) in Settings to _@your-domain.com, then serve the file this tab shows.';
export const BAD_DOMAIN =
  'Your store address (nip05) is not a public domain name. Fix it in Settings.';
export const NOT_CHECKED =
  'This page does not check your domain: once the file is served, open its address in a browser to see it.';
export const STRICT_ORIGIN =
  'Add strict-origin to the element to also refuse to sell for a store no domain vouches for (level C).';
export const CUSTOMER_REF =
  'customer-ref (the account a payment credits, through your webhook) works only for a level A store, on a page of its own domain; it turns strict-origin on.';

/** Level A: what the store's domain serves so it vouches for the store (S) and its owner (O). */
export function DomainGuide({ view, nip05 }: Props) {
  const guide = domainGuide(nip05, view.storePubkey, view.owner);
  let body: ReactNode;
  if (guide.kind === 'none') {
    body = <Notice tone="info">{NO_DOMAIN}</Notice>;
  } else if (guide.kind === 'invalid') {
    body = <Notice tone="warn">{BAD_DOMAIN}</Notice>;
  } else if (guide.kind === 'owner_name') {
    body = (
      <Notice tone="warn">
        Your store address uses the name owner, which nostr.json keeps for the owner key. Set it to
        _@{guide.domain} in Settings.
      </Notice>
    );
  } else {
    body = (
      <div className="flex flex-col gap-12">
        {guide.levelA ? (
          <p className="text-13 text-text-2">
            At level A the checkout shows Verified: {guide.domain}, and sells only on pages served
            over https from {guide.domain} or its subdomains (never localhost).
          </p>
        ) : (
          <Notice tone="warn">
            Only the domain-wide name _ gives level A: as {guide.local}@{guide.domain} the store
            stays level C. Set its address to _@{guide.domain} in Settings for level A.
          </Notice>
        )}
        <p className="text-13 text-text-2">
          Serve this file at <span className="font-mono break-all">{guide.url}</span> with the
          header <span className="font-mono">Access-Control-Allow-Origin: *</span>. It names your
          store key under {guide.local} and your owner key under owner.
        </p>
        <CodeBlock id="embed-nostr-json" label="nostr.json" text={guide.json} />
        <p className="text-13 text-text-2">{NOT_CHECKED}</p>
      </div>
    );
  }
  return (
    <section className="flex flex-col gap-12">
      <h3 className="text-15 font-semibold">Level A: your domain vouches for the store</h3>
      {body}
      <p className="text-13 text-text-2">{STRICT_ORIGIN}</p>
      <p className="text-13 text-text-2">{CUSTOMER_REF}</p>
    </section>
  );
}
