/** Create an element with an optional class and text. Text always goes through `textContent`. */
export function element<Tag extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: Tag,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** An https URL, or none: avatars, images and links from signed events still get checked. */
export function httpsUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
