/** A count with its noun: `1 order`, `2 orders`. */
export function countText(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
