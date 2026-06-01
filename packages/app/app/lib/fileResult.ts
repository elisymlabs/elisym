import { attachmentsOf, decodeJobPayload, type FileAttachment } from '@elisym/sdk';
import { tooLargeResultNotice } from '~/lib/resultPayload';

export type MediaKind = 'image' | 'audio' | 'video' | 'file';

export interface DecodedResult {
  text?: string;
  /** All file attachments (empty for a text-only payload; >1 for a multi-file result). */
  attachments: FileAttachment[];
}

/**
 * Envelope-decode a RAW relay result content (the history + poller paths get raw
 * content from `queryJobResults`). The live `onResult` callback already receives a
 * decoded `content` + `attachments`, so it must NOT call this. A malformed envelope
 * falls back to treating the raw string as the text rather than dropping the result.
 */
export function decodeResult(content: string): DecodedResult {
  try {
    const decoded = decodeJobPayload(content);
    return { text: decoded.text, attachments: attachmentsOf(decoded) };
  } catch {
    return { text: content, attachments: [] };
  }
}

/** A result attachment is browser-fetchable only when it carries a blossom member. */
export function hasBlossom(attachment: FileAttachment): boolean {
  return attachment.transports.some((transport) => transport.kind === 'blossom');
}

/** Human-readable byte size. Sizes are plain integers (not money), so plain math is fine. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function mediaKind(mime: string): MediaKind {
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime.startsWith('audio/')) {
    return 'audio';
  }
  if (mime.startsWith('video/')) {
    return 'video';
  }
  return 'file';
}

/**
 * The single source of the string stored in an Artifact's `result`. Never returns
 * an empty string for a file result, so the capturer guard fires and the tile /
 * Copy stay non-blank. A blossom file result is rendered by FileResultCard, so this
 * label is only the tile preview + Copy text for that case.
 */
export function resultDisplay(decoded: DecodedResult): string {
  const text = decoded.text;
  if (text !== undefined && text.trim() !== '') {
    return text;
  }
  const attachments = decoded.attachments;
  if (attachments.length > 1) {
    return `${attachments.length} files: ${attachments.map((a) => a.name).join(', ')}`;
  }
  const only = attachments[0];
  if (only !== undefined) {
    return hasBlossom(only)
      ? `File: ${only.name} (${formatBytes(only.size)})`
      : tooLargeResultNotice(only);
  }
  return text ?? '';
}

/** Strip any path separators a provider-supplied filename might carry. */
function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'download';
  return base.trim() || 'download';
}

/** Trigger a browser save of the decrypted bytes via a transient object URL. */
export function saveDecryptedFile(bytes: Uint8Array, name: string, mime: string): void {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeFilename(name);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click is processed so the download is not cancelled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
