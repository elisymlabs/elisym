import { cn } from '~/lib/cn';

interface Props {
  className?: string;
}

export function WalletGlyph({ className }: Props) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-16 text-text-2', className)}
    >
      <rect x="2.5" y="6" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19" />
      <circle cx="17" cy="15" r="1.3" fill="currentColor" />
    </svg>
  );
}
