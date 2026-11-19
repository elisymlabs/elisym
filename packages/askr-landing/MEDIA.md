# Askr landing: photos

Every photo on the page was generated with Higgsfield (model `z_image`,
2048 px), resized and saved as WebP in `src/media/`, and is imported in
`src/media.ts`. Keep each file under 200 KB (a test checks it).

Look: bright, calm interiors and product shots on light neutral backgrounds,
soft daylight. No people, no text, no logos.

The hero's store photos, one per niche:

| File                    | Prompt (abridged)                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `hero-electronics.webp` | Bright electronics boutique, oak shelves with over-ear headphones, a desk with headphones and chargers |
| `hero.webp` (Fashion)   | Bright boutique, oak shelves and table, folded knitwear in navy, oat and rust, ceramics                |
| `hero-home.webp`        | Calm bedroom, a ceramic bedside lamp and linen bedding, morning light                                  |
| `hero-beauty.webp`      | Skincare counter with glass bottles and jars, soft light                                               |

The products on the widget's cards, each on a light seamless background in soft studio light:

| File                    | Product                                   |
| ----------------------- | ----------------------------------------- |
| `headphones-sand.webp`  | Over-ear headphones in sand               |
| `headphones-black.webp` | Over-ear headphones in black              |
| `earbuds.webp`          | White sport earbuds in their case         |
| `charger.webp`          | A white 65 W USB-C charger with its cable |
| `sweater.webp`          | A folded navy merino crew sweater         |
| `cardigan.webp`         | A folded oat lambswool cardigan           |
| `lamp.webp`             | A sage ceramic bedside lamp               |
| `bedding.webp`          | An oat linen duvet set                    |
| `serum.webp`            | A 30 ml hydrating serum bottle            |
| `cream.webp`            | A 50 ml barrier cream jar                 |

A hero loop (image to video) needs a paid Higgsfield plan; the CSP already
allows `media-src 'self'` for it.
