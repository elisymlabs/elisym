/** The elisym logo, as app.elisym.network shows it: white on the dark page, black on the light one. */
export function ElisymLogo() {
  return (
    <picture>
      <source srcSet="/elisym-logo-black.png" media="(prefers-color-scheme: light)" />
      <img
        src="/elisym-logo-white.png"
        alt="elisym"
        width={61}
        height={16}
        className="h-16 w-auto opacity-70"
      />
    </picture>
  );
}
