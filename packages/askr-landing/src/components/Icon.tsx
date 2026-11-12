const PATHS = {
  key: 'M15 7a4 4 0 1 1-3.87 5H9v2H7v2H4v-3l6.13-6.13A4 4 0 0 1 15 7Zm1 2.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1Z',
  code: 'm8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14',
  bot: 'M12 3v3M7 9h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Zm2 4v1m6-1v1M3 13v2m18-2v2',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-4',
  check: 'm5 12 4 4 10-10',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  table: 'M4 5h16v14H4V5Zm0 5h16M4 14.5h16M10 5v14',
  tag: 'M3 12V4h8l10 10-8 8L3 12Zm5-5h.01',
  plug: 'M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4',
  store:
    'M4 9 5.5 4h13L20 9M4 9h16M4 9a2.67 2.67 0 0 0 5.33 0 2.67 2.67 0 0 0 5.34 0A2.67 2.67 0 0 0 20 9M5 11.5V20h14v-8.5M10 20v-5h4v5',
  cart: 'M3 4h2l2.4 10.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.76L20 8H6.2M9 20h.01M17 20h.01',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  globe:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.5-2.5 3.5-5.5 3.5-9S14.5 5.5 12 3m0 18c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3M3.5 9h17m-17 6h17',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
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
