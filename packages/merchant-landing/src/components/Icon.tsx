const PATHS = {
  wallet:
    'M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1h1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm13 5h4v4h-4a2 2 0 0 1 0-4Z',
  key: 'M15 7a4 4 0 1 1-3.87 5H9v2H7v2H4v-3l6.13-6.13A4 4 0 0 1 15 7Zm1 2.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Z',
  code: 'm8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14',
  bot: 'M12 3v3M7 9h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Zm2 4v1m6-1v1M3 13v2m18-2v2',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-4',
  globe:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.5-2.5 3.5-5.5 3.5-9S14.5 5.5 12 3m0 18c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3M3.5 9h17m-17 6h17',
  check: 'm5 12 4 4 10-10',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6v-9Z',
  table: 'M4 5h16v14H4V5Zm0 5h16M4 14.5h16M10 5v14',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6l1-7Z',
  plus: 'M12 5v14M5 12h14',
} as const;

export type IconName = keyof typeof PATHS;

interface Props {
  name: IconName;
  className?: string;
}

/** A stroke icon drawn inline: the page loads no image for it. */
export function Icon({ name, className = 'size-20' }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
