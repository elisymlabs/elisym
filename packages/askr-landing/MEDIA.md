# Askr landing: photos

Every photo on the page was generated with Higgsfield (model `z_image`,
2048 px), resized and saved as WebP in `src/media/`, and is imported in
`src/media.ts`. Keep each file under 200 KB (a test checks it).

Look: warm cream paper, soft daylight, oak, linen and knitwear in navy, oat and
rust, one muted teal accent. No people, no text, no logos.

| File                  | Prompt (abridged)                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `hero.webp` (Fashion) | Bright boutique interior, morning daylight from tall windows, oak shelves and table, folded knitwear in navy, oat and rust, ceramics, teal vase |
| `catalog.webp`        | Bright minimalist stockroom of an electronics store: oak shelves, off-white boxes, headphones, earbuds cases and chargers in tidy rows, z_image |
| `keys.webp`           | A single brass key on folded linen on a travertine counter, low warm side light                                                                 |
| `sweater.webp`        | Folded navy merino crew sweater on a cream seamless background, soft studio daylight                                                            |
| `cardigan.webp`       | Folded oat lambswool cardigan with horn buttons, same setup                                                                                     |
| `beanie.webp`         | Rust ribbed wool beanie, same setup                                                                                                             |

A hero loop (image to video from `hero.webp`) needs a paid Higgsfield plan;
the CSP already allows `media-src 'self'` for it.
