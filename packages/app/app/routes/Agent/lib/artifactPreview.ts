export function cleanPreviewText(s: string): string {
  return s
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[=\-*_]{3,}\s*$/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
