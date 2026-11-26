import type { ReactNode } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { CARD } from '../styles';
import { NewOwnerKeyCard } from './NewOwnerKeyCard';

interface Props {
  nsec: string;
  /** Its Owner ID: written in the key file. */
  npub: string;
  onContinue: () => void;
  onCancel: () => void;
  /** Continue is at work (remembering the key): it waits and says so. */
  busy?: boolean;
  /** More choices before Continue, such as remembering the key on this device. */
  children?: ReactNode;
}

const NEW_KEY_INTRO =
  'PayCore has no accounts or passwords. This key is how you sign in, and it signs your payout addresses: keep it like a password. Anyone who has it controls your store, and nobody can recover it for you. It is shown only once.';

/** A new owner key, shown once, to save before going on. */
export function NewOwnerKey({ nsec, npub, onContinue, onCancel, busy = false, children }: Props) {
  return (
    <AuthLayout>
      <div className={`${CARD} max-w-560`}>
        <NewOwnerKeyCard
          header={
            <div className="flex flex-col gap-8">
              <h1 className="text-24 font-semibold tracking-tight">Save your owner key</h1>
              <p className="text-15 text-text-2 leading-relaxed">{NEW_KEY_INTRO}</p>
            </div>
          }
          nsec={nsec}
          npub={npub}
          onContinue={onContinue}
          onCancel={onCancel}
          busy={busy}
        >
          {children}
        </NewOwnerKeyCard>
      </div>
    </AuthLayout>
  );
}
