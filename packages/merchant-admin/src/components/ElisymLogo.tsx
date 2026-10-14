/** The elisym logo, as app.elisym.network shows it: black on the light page, white on the dark one. */
export function ElisymLogo() {
  return (
    <picture>
      <source srcSet="/elisym-logo-white.png" media="(prefers-color-scheme: dark)" />
      <img
        src="/elisym-logo-black.png"
        alt="elisym"
        width={61}
        height={16}
        className="h-16 w-auto opacity-70"
      />
    </picture>
  );
}
