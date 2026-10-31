/**
 * The ids a `Field`'s control is described by: its hint and its error, when
 * the field shows them (the ids `Field` gives them).
 */
export function describedBy(
  id: string,
  hint: unknown,
  error: string | undefined,
): string | undefined {
  const ids = [
    ...(hint === undefined ? [] : [`${id}-hint`]),
    ...(error === undefined || error === '' ? [] : [`${id}-error`]),
  ];
  return ids.length === 0 ? undefined : ids.join(' ');
}
