import { AuthLayout } from '../../components/AuthLayout';
import { CARD, LINK } from '../styles';

/** Hosted mode before PayCore's server is set up: nothing to sign in to yet. */
export function NotAvailable() {
  return (
    <AuthLayout>
      <div className={`${CARD} flex max-w-520 flex-col gap-8`}>
        <h1 className="text-24 font-semibold tracking-tight">
          Hosted stores are not available yet
        </h1>
        <p className="text-15 text-text-2 leading-relaxed">
          PayCore will run stores for you here soon. Until then, run your own node and sign in with
          its store key.
        </p>
        <p className="text-14 mt-8">
          <a href="/" className={LINK}>
            Sign in with your store key
          </a>
        </p>
      </div>
    </AuthLayout>
  );
}
