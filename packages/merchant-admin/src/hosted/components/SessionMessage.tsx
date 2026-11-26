import type { ReactNode } from 'react';
import { AuthLayout } from '../../components/AuthLayout';
import { CARD } from '../styles';

interface Props {
  title: string;
  /** The message and the actions under it. */
  children: ReactNode;
}

/** A signed-in page that is not the store yet: loading, a refusal, a failure, or no store. */
export function SessionMessage({ title, children }: Props) {
  return (
    <AuthLayout>
      <div className={`${CARD} flex max-w-560 flex-col gap-16`}>
        <h1 className="text-24 font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </AuthLayout>
  );
}
