const ITEMS = [
  'Shopify',
  'WooCommerce',
  'Google product feed',
  'CSV',
  'PayCore',
  'Your own code',
  'AI agents over MCP',
];

/** The sources a catalog comes from, on a slow loop. */
export function WorksWith() {
  const row = ITEMS.map((item) => (
    <li key={item} className="flex shrink-0 items-center gap-40 pr-40">
      <span className="text-32 sm:text-40 font-serif italic">{item}</span>
      <span aria-hidden="true" className="text-accent text-20">
        ✳
      </span>
    </li>
  ));
  return (
    <section id="works-with" aria-labelledby="works-with-title" className="py-56 sm:py-72">
      <h2
        id="works-with-title"
        className="text-12 text-text-3 text-center font-semibold tracking-[0.14em] uppercase"
      >
        Brings in the catalog you already have
      </h2>
      <div className="marquee mt-24 overflow-hidden">
        <ul className="marquee-track flex w-max">
          {row}
          {ITEMS.map((item) => (
            <li
              key={`${item}-again`}
              aria-hidden="true"
              className="flex shrink-0 items-center gap-40 pr-40"
            >
              <span className="text-32 sm:text-40 font-serif italic">{item}</span>
              <span className="text-accent text-20">✳</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
