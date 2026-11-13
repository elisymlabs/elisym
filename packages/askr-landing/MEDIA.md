# Askr landing: photos

Every photo on the page was generated with Higgsfield (model `z_image`,
2048 px), resized and saved as WebP in `src/media/`, and is imported in
`src/media.ts`. Keep each file under 200 KB (a test checks it).

Look: warm cream paper, soft daylight, oak, linen and knitwear in navy, oat and
rust, one muted teal accent. No people, no text, no logos.

| File            | Prompt (abridged)                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `hero.webp`     | Bright boutique interior, morning daylight from tall windows, oak shelves and table, folded knitwear in navy, oat and rust, ceramics, teal vase |
| `closing.webp`  | Small boutique storefront at golden hour, cream stone facade, muted teal door, potted olive tree, knitwear visible inside                       |
| `catalog.webp`  | Top-down flat lay of store products in an even grid on cream paper: sweater, sneakers, headphones, watch, notebook, beanie, sunglasses          |
| `keys.webp`     | A single brass key on folded linen on a travertine counter, low warm side light                                                                 |
| `sweater.webp`  | Folded navy merino crew sweater on a cream seamless background, soft studio daylight                                                            |
| `cardigan.webp` | Folded oat lambswool cardigan with horn buttons, same setup                                                                                     |
| `beanie.webp`   | Rust ribbed wool beanie, same setup                                                                                                             |

A hero loop (image to video from `hero.webp`) needs a paid Higgsfield plan;
the CSP already allows `media-src 'self'` for it.
