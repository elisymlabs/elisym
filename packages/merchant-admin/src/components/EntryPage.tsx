import { PRODUCT_NAME } from '../constants';
import { AuthLayout } from './AuthLayout';
import { Button } from './Button';

interface Props {
  onCreate: () => void;
  onSignIn: () => void;
}

/**
 * The admin's front door in a build with the cloud: make a store in our cloud,
 * or sign in to the one you have (in our cloud or on your own node: one field).
 */
export function EntryPage({ onCreate, onSignIn }: Props) {
  return (
    <AuthLayout>
      <div className="grid w-full max-w-960 gap-16 md:grid-cols-2">
        <h1 className="sr-only">{`${PRODUCT_NAME} admin`}</h1>
        <section className="rounded-20 border-accent-ink bg-surface flex flex-col gap-12 border p-24 shadow-sm sm:p-32">
          <h2 className="text-24 font-semibold tracking-tight">Create a store in our cloud</h2>
          <p className="text-15 text-text-2 leading-relaxed">
            {`Pick a plan, make your owner key, pay the first month: we run your ${PRODUCT_NAME} store, and buyers pay straight to your wallets.`}
          </p>
          <Button variant="primary" size="lg" onClick={onCreate} className="mt-auto self-start">
            Create a store
          </Button>
        </section>
        <section className="rounded-20 border-line bg-surface flex flex-col gap-12 border p-24 shadow-sm sm:p-32">
          <h2 className="text-24 font-semibold tracking-tight">Sign in</h2>
          <p className="text-15 text-text-2 leading-relaxed">
            Open your store, in our cloud or on your own node: its orders, numbers and settings.
            Your key stays in this tab.
          </p>
          <Button onClick={onSignIn} size="lg" className="mt-auto self-start">
            Sign in to your store
          </Button>
        </section>
      </div>
    </AuthLayout>
  );
}
