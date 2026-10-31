/** A field of an answer's JSON body (undefined when the body is not an object). */
export function fieldOf(body: unknown, name: string): unknown {
  const fields: Record<string, unknown> =
    body !== null && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  return fields[name];
}
