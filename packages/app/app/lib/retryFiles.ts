/**
 * Per-tab, in-memory registry of the `File` objects behind file-input jobs,
 * keyed by jobEventId. Lets a failed file job Retry within the same tab
 * session (the original `File` does not survive a reload, and a stored
 * blossom descriptor's blob lifetime is not guaranteed) - after a reload the
 * Chat tab shows a "re-attach the file to retry" hint instead.
 *
 * Deliberately unbounded-but-tiny: values are `File` references (no bytes
 * copied) and the map lives only as long as the tab.
 */
const FILES_BY_JOB_EVENT_ID = new Map<string, File>();

export function rememberJobFile(jobEventId: string, file: File): void {
  FILES_BY_JOB_EVENT_ID.set(jobEventId, file);
}

export function recallJobFile(jobEventId: string): File | undefined {
  return FILES_BY_JOB_EVENT_ID.get(jobEventId);
}
