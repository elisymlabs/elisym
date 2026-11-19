import type { ReactNode } from 'react';

interface Props {
  href: string;
  className: string;
  /** Opens in a new tab, leaving this page where it is. */
  newTab?: boolean;
  children: ReactNode;
}

/** A link off this page: no handle on it for the page it opens, no referrer. */
export function ExternalLink({ href, className, newTab = false, children }: Props) {
  return (
    <a
      href={href}
      target={newTab ? '_blank' : undefined}
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  );
}
