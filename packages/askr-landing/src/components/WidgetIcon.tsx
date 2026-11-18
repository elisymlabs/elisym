const ICONS = {
  // The widget's own drawings (card-view.ts and element.ts).
  cart: (
    <>
      <path d="M3 4h2.2l2.3 10.1a1.2 1.2 0 0 0 1.2.9h8.6a1.2 1.2 0 0 0 1.2-.9L20 8H6.1" />
      <circle cx="9.5" cy="19.5" r="1.4" />
      <circle cx="16.5" cy="19.5" r="1.4" />
    </>
  ),
  close: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" transform="scale(1.5)" />,
};

interface Props {
  name: keyof typeof ICONS;
  className?: string;
}

/** An icon the widget draws, stroked in the current color. */
export function WidgetIcon({ name, className }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'cart' ? 1.8 : 1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
