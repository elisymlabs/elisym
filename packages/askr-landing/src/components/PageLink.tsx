import type { ReactNode } from 'react';
import { ExternalLink } from './ExternalLink';

interface Props {
  href: string;
  className: string;
  children: ReactNode;
}

/** A link to a section of this page, or to another page with no referrer. */
export function PageLink({ href, className, children }: Props) {
  if (href.startsWith('#')) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <ExternalLink href={href} className={className}>
      {children}
    </ExternalLink>
  );
}
