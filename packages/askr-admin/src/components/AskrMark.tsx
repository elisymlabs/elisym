import type { CSSProperties } from 'react';

/** The Askr mark, drawn still: the rim and six rings, ink and paper by turns. */
const MARK_PATHS = [
  'M59.67 24.84 A11.00 11.00 0 0 0 40.33 24.84 L13.81 73.76 A11.00 11.00 0 0 0 23.48 90.00 L76.52 90.00 A11.00 11.00 0 0 0 86.19 73.76Z',
  'M59.74 28.42 A10.12 10.12 0 0 0 41.94 28.42 L17.54 73.42 A10.12 10.12 0 0 0 26.44 88.37 L75.24 88.37 A10.12 10.12 0 0 0 84.14 73.42Z',
  'M59.85 34.65 A8.59 8.59 0 0 0 44.76 34.65 L24.05 72.84 A8.59 8.59 0 0 0 31.60 85.52 L73.01 85.52 A8.59 8.59 0 0 0 80.56 72.84Z',
  'M59.97 40.89 A7.05 7.05 0 0 0 47.57 40.89 L30.56 72.26 A7.05 7.05 0 0 0 36.76 82.67 L70.78 82.67 A7.05 7.05 0 0 0 76.98 72.26Z',
  'M60.09 47.13 A5.52 5.52 0 0 0 50.38 47.13 L37.07 71.68 A5.52 5.52 0 0 0 41.93 79.83 L68.55 79.83 A5.52 5.52 0 0 0 73.40 71.68Z',
  'M60.21 53.36 A3.99 3.99 0 0 0 53.20 53.36 L43.59 71.09 A3.99 3.99 0 0 0 47.09 76.98 L66.32 76.98 A3.99 3.99 0 0 0 69.82 71.09Z',
  'M60.32 59.60 A2.45 2.45 0 0 0 56.01 59.60 L50.10 70.51 A2.45 2.45 0 0 0 52.25 74.13 L64.08 74.13 A2.45 2.45 0 0 0 66.24 70.51Z',
];

interface Props {
  className?: string;
  style?: CSSProperties;
}

export function AskrMark({ className, style }: Props) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {MARK_PATHS.map((path, index) => (
        <path key={path} d={path} className={index % 2 === 0 ? 'mark-ink' : 'mark-paper'} />
      ))}
    </svg>
  );
}
