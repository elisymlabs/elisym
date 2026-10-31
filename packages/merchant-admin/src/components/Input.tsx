import type { ComponentProps } from 'react';

interface Props extends ComponentProps<'input'> {
  /** Keys, addresses and URLs: monospaced. */
  mono?: boolean;
}

/** The console's text field. */
export function Input({ mono = false, className, ...rest }: Props) {
  const classes = [
    'rounded-10 border-line-2 bg-bg text-14 border px-12 py-8',
    'placeholder:text-text-3 focus:border-accent-ink',
    mono ? 'font-mono' : '',
    className ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
  return <input className={classes} {...rest} />;
}
