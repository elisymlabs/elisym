interface Props {
  /** The white logo, for an ink background. */
  onInk?: boolean;
}

/** The elisym logo, black on the light page or white on ink. */
export function ElisymLogo({ onInk = false }: Props) {
  return (
    <img
      src={onInk ? '/elisym-logo-white.png' : '/elisym-logo-black.png'}
      alt="elisym"
      width={61}
      height={16}
      className="h-14 w-auto opacity-70"
    />
  );
}
