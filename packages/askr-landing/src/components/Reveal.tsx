import type { ReactNode } from 'react';
import { useInView } from '../useInView';

interface Props {
  children: ReactNode;
  className?: string;
  delay?: 0 | 1 | 2 | 3;
}

const DELAYS = ['', 'reveal-delay-1', 'reveal-delay-2', 'reveal-delay-3'];

/** Rises in the first time it scrolls into view; reduced motion shows it as it is. */
export function Reveal({ children, className = '', delay = 0 }: Props) {
  const [ref, inView] = useInView<HTMLDivElement>(0.15);
  return (
    <div ref={ref} data-shown={inView} className={`reveal ${DELAYS[delay]} ${className}`}>
      {children}
    </div>
  );
}
