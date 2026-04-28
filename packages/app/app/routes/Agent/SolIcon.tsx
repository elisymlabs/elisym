import { useId } from 'react';
import { cn } from '~/lib/cn';

const SOL_PATH =
  'M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z';

interface Props {
  className?: string;
  /** Render with `currentColor` instead of the brand gradient (for inline text contexts). */
  mono?: boolean;
}

export function SolIcon({ className, mono = false }: Props) {
  const gradientId = useId();
  if (mono) {
    return (
      <svg
        aria-hidden
        viewBox="0 0 397.7 311.7"
        fill="currentColor"
        className={cn('size-12', className)}
      >
        <path d={SOL_PATH} />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 397.7 311.7" className={cn('size-12', className)}>
      <linearGradient
        id={gradientId}
        gradientUnits="userSpaceOnUse"
        x1="360.88"
        y1="351.46"
        x2="141.21"
        y2="-69.29"
        gradientTransform="matrix(1 0 0 -1 0 314)"
      >
        <stop offset="0" stopColor="#00ffa3" />
        <stop offset="1" stopColor="#dc1fff" />
      </linearGradient>
      <path fill={`url(#${gradientId})`} d={SOL_PATH} />
    </svg>
  );
}
