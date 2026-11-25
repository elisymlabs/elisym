import { Notice } from './Notice';

interface Props {
  onSignOut: () => void;
}

/**
 * Signed in with the owner key of a store the Shopify app manages (askr-shopify 5.3): its
 * settings, products and policies change in the Askr app in Shopify, so nothing here edits them
 * (the server refuses every write while the app manages the store).
 */
export function ManagedByShopify({ onSignOut }: Props) {
  return (
    <main className="mx-auto flex min-h-screen max-w-560 flex-col justify-center gap-16 px-16 py-40">
      <h1 className="text-24 font-semibold">Managed by the Shopify app</h1>
      <Notice tone="info">
        This store is set up and managed in the Askr app inside your Shopify admin. Open Askr from
        your Shopify admin to change its settings and plan. Keep this key safe: it is the root of
        your store.
      </Notice>
      <div>
        <button type="button" className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </main>
  );
}
