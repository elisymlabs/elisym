import * as z from 'zod';

/**
 * A tool's input schema as MCP clients receive it: draft-07 JSON Schema of what the tool
 * accepts, inlined (no `$ref`), without the `$schema` meta field, so every client can read it.
 * Objects say `additionalProperties: false`, as they did before zod 4: unknown keys are
 * stripped, so a client should not send them.
 */
export function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _metaSchema, ...json } = z.toJSONSchema(schema, {
    target: 'draft-07',
    io: 'input',
    reused: 'inline',
    unrepresentable: 'any',
    override: (context) => {
      const node = context.jsonSchema;
      if (node.type === 'object' && node.additionalProperties === undefined) {
        node.additionalProperties = false;
      }
    },
  });
  return json;
}
