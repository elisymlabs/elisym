import type { ReactNode } from 'react';

interface Props {
  href: string;
  className: string;
  children: ReactNode;
}

/** A link off this page: no handle on it for the page it opens, no referrer. */
export function ExternalLink({ href, className, children }: Props) {
  return (
    <a href={href} rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
