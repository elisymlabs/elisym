/**
 * The page's generated media, picked up from `src/media/` at build time. A slot
 * whose file is not there yet draws its placeholder instead, so the page builds
 * and reads the same before and after the visuals land. Prompts and sizes for
 * each file are in `MEDIA.md`.
 */
const FILES = import.meta.glob<string>('./media/*.{webp,jpg,png,mp4,webm}', {
  eager: true,
  query: '?url',
  import: 'default',
});

export interface MediaSlot {
  /** The still: a poster for a video slot, the image for an image slot. */
  image: string;
  /** The loop, for a video slot. */
  video?: string;
  alt: string;
}

export const MEDIA = {
  hero: {
    image: 'hero.webp',
    video: 'hero.mp4',
    alt: 'Products on soft lit shelves in a quiet store',
  },
  catalog: {
    image: 'catalog.webp',
    alt: 'A store catalog laid out as neat rows of products',
  },
  keys: {
    image: 'keys.webp',
    alt: 'A single key resting on a store counter',
  },
  closing: {
    image: 'closing.webp',
    video: 'closing.mp4',
    alt: 'A storefront at dusk with its lights on',
  },
} satisfies Record<string, MediaSlot>;

export type MediaName = keyof typeof MEDIA;

/** The built URL of a media file, or `undefined` while it is not in `src/media/`. */
export function mediaUrl(file: string | undefined): string | undefined {
  return file === undefined ? undefined : FILES[`./media/${file}`];
}
