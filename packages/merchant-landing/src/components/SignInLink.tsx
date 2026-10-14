import { ADMIN_URL } from '../constants';

interface Props {
  className: string;
  label?: string;
}

/** A plain link to the admin's own origin: no handle on this page, no referrer. */
export function SignInLink({ className, label = 'Sign in' }: Props) {
  return (
    <a href={ADMIN_URL} rel="noopener noreferrer" className={className}>
      {label}
    </a>
  );
}
