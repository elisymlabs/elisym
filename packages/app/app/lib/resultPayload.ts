import type { FileAttachment } from '@elisym/sdk';

/**
 * A provider can spill a large text/file result to iroh and deliver it as an
 * attachment with empty inline content. The browser cannot fetch iroh blobs
 * (the transport is node-only), so we surface a clear notice instead of an empty
 * or raw-envelope result.
 */
export function tooLargeResultNotice(attachment: FileAttachment): string {
  return (
    `This result was delivered as a file (${attachment.size} bytes) and is too large to ` +
    `receive in the browser. Fetch it with the elisym CLI or MCP (fetch_job_file).`
  );
}
