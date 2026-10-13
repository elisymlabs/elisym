/** Hand `text` to the browser as a file to save; the object URL is revoked after the click, never during it. */
export function downloadText(doc: Document, text: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
