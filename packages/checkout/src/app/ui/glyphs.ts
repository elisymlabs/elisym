/**
 * Bundled glyphs as data URIs: the checkout's CSP allows images from `data:`
 * only, and it loads nothing from elsewhere.
 */
function svg(body: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`,
  )}`;
}

export const SOLANA_GLYPH = svg(
  '<defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#9945ff"/><stop offset="1" stop-color="#14f195"/></linearGradient></defs>' +
    '<circle cx="12" cy="12" r="12" fill="#111418"/>' +
    '<path fill="url(#g)" d="M7.6 15.2h8.9l-1.9 1.9H5.7zM7.6 6.9h8.9l-1.9 1.9H5.7zM14.6 11.05H5.7l1.9-1.9h8.9z"/>',
);

export const TEMPO_GLYPH = svg(
  '<circle cx="12" cy="12" r="12" fill="#0b0b0f"/>' +
    '<path fill="#fff" d="M7 7.5h10v2.2h-3.8V17h-2.4V9.7H7z"/>',
);

export const CHECK_GLYPH = svg(
  '<circle cx="12" cy="12" r="12" fill="#1f9d55"/>' +
    '<path fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M7 12.5l3.2 3.2L17 9"/>',
);

export const STOP_GLYPH = svg(
  '<circle cx="12" cy="12" r="12" fill="#b42318"/>' +
    '<path fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>',
);

export const RETURN_GLYPH = svg(
  '<circle cx="12" cy="12" r="12" fill="#5b6470"/>' +
    '<path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9.5 8L6.5 11l3 3M7 11h6.5a3.5 3.5 0 010 7H11"/>',
);
