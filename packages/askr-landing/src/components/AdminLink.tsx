import { ADMIN_URL } from '../constants';
import { ExternalLink } from './ExternalLink';

interface Props {
  className: string;
  label?: string;
}

/** The admin lives on the Askr server's origin, never this page's. */
export function AdminLink({ className, label = 'Open the admin' }: Props) {
  return (
    <ExternalLink href={ADMIN_URL} className={className}>
      {label}
    </ExternalLink>
  );
}
