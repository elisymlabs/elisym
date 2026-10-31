/**
 * Hands `data` to the browser as a file to save (text as plain text, bytes as
 * they are); the object URL is revoked after the click, never during it.
 */
export function downloadFile(
  doc: Document,
  data: string | Uint8Array<ArrayBuffer>,
  fileName: string,
): void {
  const type = typeof data === 'string' ? 'text/plain' : 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  doc.body.append(link);
  link.click();
  link.remove();
  // Revoking at once cancels the download in Firefox and older Safari.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
