import { PRODUCT_NAME } from '../constants';
import { AuthLayout } from './AuthLayout';
import { Button } from './Button';

interface Props {
  /** The cloud is on in this build: a store can be made here. */
  cloud: boolean;
  onCreate: () => void;
  onCloudSignIn: () => void;
  onSelfHostedSignIn: () => void;
}

/** The admin's front door: make a store in our cloud, or open the one you have. */
export function EntryPage({ cloud, onCreate, onCloudSignIn, onSelfHostedSignIn }: Props) {
  return (
    <AuthLayout>
      <div className="grid w-full max-w-960 gap-16 md:grid-cols-2">
        <h1 className="sr-only">{`${PRODUCT_NAME} admin`}</h1>
        {cloud ? (
          <section className="rounded-20 border-accent-ink bg-surface flex flex-col gap-12 border p-24 shadow-sm sm:p-32">
            <h2 className="text-24 font-semibold tracking-tight">Create a store in our cloud</h2>
            <p className="text-15 text-text-2 leading-relaxed">
              {`Pick a plan, make your owner key, pay the first month: we run your ${PRODUCT_NAME} store, and buyers pay straight to your wallets.`}
            </p>
            <Button variant="primary" size="lg" onClick={onCreate} className="mt-auto self-start">
              Create a store
            </Button>
          </section>
        ) : null}
        <section className="rounded-20 border-line bg-surface flex flex-col gap-12 border p-24 shadow-sm sm:p-32">
          <h2 className="text-24 font-semibold tracking-tight">Sign in</h2>
          <p className="text-15 text-text-2 leading-relaxed">
            Open your store: its orders, numbers and settings. Your key stays in this tab.
          </p>
          <div className="mt-auto flex flex-wrap gap-8">
            {cloud ? (
              <Button
                variant="primary"
                onClick={onCloudSignIn}
                aria-label="Sign in to a store in our cloud"
              >
                A store in our cloud
              </Button>
            ) : null}
            <Button onClick={onSelfHostedSignIn} aria-label="Sign in to a store you run yourself">
              A store you run yourself
            </Button>
          </div>
        </section>
      </div>
    </AuthLayout>
  );
}
