import { useState } from 'react';

interface Props {
  /** The product's first image, if it has one. */
  src: string | undefined;
}

/** A small square picture of a product, or a quiet placeholder when it has none or it fails. */
export function ProductThumb({ src }: Props) {
  const [failed, setFailed] = useState<string>();
  const usable = src !== undefined && src.startsWith('https://') && failed !== src;
  return (
    <span className="border-line bg-surface-2 text-text-3 rounded-8 flex size-40 shrink-0 items-center justify-center overflow-hidden border">
      {usable ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailed(src)}
        />
      ) : (
        <svg
          viewBox="0 0 24 24"
          className="size-16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m4 17 4.5-4.5 3.5 3.5 2.5-2.5L20 19" />
        </svg>
      )}
    </span>
  );
}
