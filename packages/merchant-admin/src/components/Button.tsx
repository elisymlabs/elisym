import type { ComponentProps } from 'react';

interface Props extends ComponentProps<'button'> {
  /** `primary`: the step's one action (the accent); `secondary`: everything else. */
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  /** As wide as its container. */
  full?: boolean;
}

const VARIANTS = {
  primary: 'bg-accent text-accent-text enabled:hover:brightness-95 font-semibold',
  secondary: 'border-line-2 enabled:hover:bg-surface-2 border font-medium',
} as const;

const SIZES = {
  sm: 'text-13 px-12 py-6',
  md: 'text-14 px-16 py-8',
  lg: 'text-15 px-20 py-12',
} as const;

/** The console's button: one look per role, never a hand-written class string. */
export function Button({
  variant = 'secondary',
  size = 'md',
  full = false,
  type = 'button',
  className,
  ...rest
}: Props) {
  const classes = [
    'rounded-10 transition disabled:cursor-not-allowed disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    full ? 'w-full' : '',
    className ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  return <button type={type} className={classes} {...rest} />;
}
