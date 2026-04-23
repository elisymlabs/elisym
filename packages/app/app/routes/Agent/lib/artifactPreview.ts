import { timeAgo } from '@elisym/sdk';

export function cleanPreviewText(s: string): string {
  return s
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[=\-*_]{3,}\s*$/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function formatArtifactTime(createdAt: number): string {
  const age = Date.now() - createdAt;
  if (age < ONE_WEEK_MS) {
    return timeAgo(Math.floor(createdAt / 1000));
  }
  const date = new Date(createdAt);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    undefined,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}
