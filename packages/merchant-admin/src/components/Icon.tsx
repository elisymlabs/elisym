const PATHS = {
  refresh: 'M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4m-4 5a8 8 0 0 0 14.9 3.5M20 20v-4h-4',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  download: 'M12 4v11m-4-4 4 4 4-4M5 19h14',
  search: 'm20 20-4.5-4.5M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z',
  copy: 'M9 9h10v10H9V9Zm-4 6V5h10',
  check: 'm5 12 4 4 10-10',
  chevron: 'm9 6 6 6-6 6',
  external: 'M14 5h5v5m0-5-8 8M10 7H5v12h12v-5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6v-9Z',
  eye: 'M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  terminal: 'm5 8 4 4-4 4m6 0h8',
  alert:
    'M12 9v4m0 4h.01M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z',
  info: 'M12 16v-4m0-4h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  box: 'M21 8 12 3 3 8m18 0v8l-9 5m9-13-9 5m0 8-9-5V8m9 13v-8M3 8l9 5',
  store:
    'M4 9 5.5 4h13L20 9M4 9h16M4 9v1a3 3 0 0 0 5.3 1.9A3 3 0 0 0 12 13a3 3 0 0 0 2.7-1.1A3 3 0 0 0 20 10V9M5 13v7h14v-7',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6m-6 4h3',
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4v-9Z',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6m0 3.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
} as const;

export type IconName = keyof typeof PATHS;

interface Props {
  name: IconName;
  className?: string;
}

/** A stroke icon drawn inline: the page loads no image for it, and it adds no text. */
export function Icon({ name, className = 'size-18' }: Props) {
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
