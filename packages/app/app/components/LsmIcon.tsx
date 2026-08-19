import { cn } from '~/lib/cn';

interface Props {
  className?: string;
}

/**
 * Placeholder $LSM mark until the official artwork lands: a coin outline with
 * an L monogram, drawn in `currentColor` so it inherits the stat tile tint
 * like the sibling icons.
 */
export function LsmIcon({ className }: Props) {
  return (
    <svg aria-hidden viewBox="0 0 32 32" fill="currentColor" className={cn('size-16', className)}>
      <path d="M16 32C24.84 32 32 24.84 32 16S24.84 0 16 0 0 7.16 0 16s7.16 16 16 16zm0-2.83C8.73 29.17 2.83 23.27 2.83 16S8.73 2.83 16 2.83 29.17 8.73 29.17 16 23.27 29.17 16 29.17z" />
      <path d="M12.4 8.2h3v12.6h6.75v3H12.4V8.2z" />
    </svg>
  );
}
