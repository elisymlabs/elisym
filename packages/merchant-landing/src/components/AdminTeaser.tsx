import { LOCAL_ADMIN_COMMAND } from '../constants';
import { SignInLink } from './SignInLink';

export function AdminTeaser() {
  return (
    <section className="mx-auto max-w-1120 px-16 py-64 sm:py-96">
      <div className="rounded-16 border-line bg-surface grid gap-24 border p-24 sm:p-40 lg:grid-cols-[1fr_auto] lg:items-center">
        <div className="flex flex-col gap-12">
          <h2 className="text-28 font-semibold">Your orders, in your browser</h2>
          <p className="text-text-2 max-w-640">
            Sign in with your store key to see the orders your inbox relays hold, what your node
            credited, your products and a CSV for your books. The admin reads your relays directly:
            the key stays in that tab&apos;s memory and is never sent anywhere.
          </p>
          <p className="text-14 text-text-2 max-w-640">
            Browser extensions can read what you type into any page: use a browser profile without
            extensions you do not trust, or run the same admin on your machine with{' '}
            <code className="font-mono">{LOCAL_ADMIN_COMMAND}</code>.
          </p>
        </div>
        <SignInLink
          label="Sign in to your store"
          className="rounded-8 bg-accent text-15 text-accent-text justify-self-start px-20 py-12 font-medium hover:opacity-90"
        />
      </div>
    </section>
  );
}
