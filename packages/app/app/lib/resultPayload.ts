import type { FileAttachment } from '@elisym/sdk';

/**
 * Fallback for a file result the browser cannot fetch: the attachment carries no
 * blossom member (the provider had no blossom configured or its upload fell back),
 * so only the node-only iroh transport is available. Surface a clear notice instead
 * of an empty or raw-envelope result. A result WITH a blossom member is fetched and
 * previewed in-browser instead (see lib/fileResult + FileResultCard).
 */
export function tooLargeResultNotice(attachment: FileAttachment): string {
  return (
    `This result was delivered as a file (${attachment.size} bytes) over a transport the browser ` +
    `cannot read. Fetch it with the elisym CLI or MCP (fetch_job_file).`
  );
}
