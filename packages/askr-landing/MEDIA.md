# Askr landing: generated media

The page picks up its photos and loops from `src/media/` at build time
(`src/media.ts`). A slot whose file is missing draws a soft accent placeholder,
so the page ships the same with or without them. Drop a file in under the exact
name below and rebuild; nothing else changes.

Generated with Higgsfield. Rules for every slot:

- No text, letters, logos, brand marks, UI screens or phone screens in the frame
  (generated text comes out garbled, and the page draws the real UI itself).
- No people's faces. Hands are fine.
- Palette: deep charcoal and soft warm neutrals with a teal light accent
  (close to `#2dd4bf`), so the frame sits on the dark page and on the light one.
- Calm, premium, editorial product photography. Shallow depth of field.
- Loops: 6-10 s, seamless, slow camera motion only, no cuts. Export H.264 MP4
  without audio, under 4 MB; take the poster still from the first frame.
- Stills: WebP, quality around 80, under 400 KB.

| File                           | Size        | Where                                          |
| ------------------------------ | ----------- | ---------------------------------------------- |
| `hero.mp4` + `hero.webp`       | 1200 x 1400 | Behind the chat in the hero (portrait, 6:7)    |
| `catalog.webp`                 | 1200 x 900  | "Bring the catalog you already have" (4:3)     |
| `keys.webp`                    | 1000 x 1250 | "Your store, signed by you" (4:5)              |
| `closing.mp4` + `closing.webp` | 1920 x 840  | Behind the closing call to action (wide, 16:7) |

The chat card covers the middle of the hero frame, and the closing frame sits
under a 70% page-colored veil with a headline on top: keep the subject soft and
the center calm in both.

## Prompts

**hero** (video, portrait)

> Slow cinematic dolly past wooden shelves in a quiet boutique at dusk, folded
> merino sweaters, ceramic mugs and a leather bag neatly displayed, warm soft
> practical lights with a subtle teal rim light from the left, charcoal walls,
> shallow depth of field, gentle bokeh, calm and premium, editorial product
> photography, no people, no text, no logos, seamless loop

**catalog** (still)

> Top-down flat lay of neatly arranged store products in a precise grid on a
> charcoal surface: a knit sweater, sneakers, headphones, a ceramic vase, a
> wristwatch, a notebook, each item with equal spacing like a catalog, soft
> diffused studio light with a faint teal glow at one corner, minimal, premium,
> no text, no labels, no logos

**keys** (still)

> A single solid brass key resting on a dark stone shop counter, close-up,
> dramatic low side light, a soft teal reflection on the metal, deep charcoal
> background falling into shadow, shallow depth of field, quiet and confident,
> still life photography, no text, no logos

**closing** (video, wide)

> Wide slow push-in toward a small independent storefront at blue hour, warm
> light glowing through large windows onto a wet street, products softly
> visible inside, a faint teal accent in the window light, calm and inviting,
> cinematic, no people, no readable signs, no text, no logos, seamless loop
