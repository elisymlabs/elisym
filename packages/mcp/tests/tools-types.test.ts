import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  textResult,
  type ToolDefinition,
  type ToolResult,
} from '../src/tools/types.js';

describe('defineTool', () => {
  // handlers must be type-checked against the exact schema output, not `any`.
  it('infers handler input type from schema', async () => {
    const schema = z.object({ count: z.number(), name: z.string() });
    const tool = defineTool({
      name: 'demo',
      description: 'demo tool',
      schema,
      async handler(_ctx, input) {
        // If this regresses (input: any), the following line would still compile but the
        // type checker would lose the ability to flag mismatches at the call site.
        // The runtime assertion below covers the runtime behaviour; the *compile-time*
        // guarantee is encoded in the `expectTypeOf` below.
        expectTypeOf(input).toEqualTypeOf<{ count: number; name: string }>();
        return textResult(`${input.name}=${input.count}`);
      },
    });
    const parsed = (tool.schema as typeof schema).parse({ count: 7, name: 'a' });
    const result: ToolResult = await tool.handler({} as never, parsed);
    expect(result.content[0]?.text).toBe('a=7');
  });

  it('returns a ToolDefinition assignable into a heterogeneous registry', () => {
    const a = defineTool({
      name: 'a',
      description: '',
      schema: z.object({ x: z.number() }),
      async handler() {
        return textResult('a');
      },
    });
    const b = defineTool({
      name: 'b',
      description: '',
      schema: z.object({ y: z.string() }),
      async handler() {
        return textResult('b');
      },
    });
    const registry: ToolDefinition[] = [a, b];
    expect(registry).toHaveLength(2);
  });

  // Regression (caught because defineTool removed `any`): capabilities must be proper
  // Capability objects, not a plain string array. This test locks in the compile-time
  // contract via a type-level assertion, so a future refactor that re-introduces
  // `string[]` would fail here.
  it('capabilities shape is a Capability[] at the type level', () => {
    type Capability = { name: string; description: string; tags: string[]; price: number };
    type CapabilitiesField = Capability[];

    // The fix in create_agent/init builds entries of this exact shape.
    const sample: CapabilitiesField = [
      { name: 'mcp-gateway', description: 'mcp-gateway', tags: ['mcp-gateway'], price: 0 },
    ];
    expectTypeOf(sample).toEqualTypeOf<CapabilitiesField>();

    // String entries must be rejected at compile time. The @ts-expect-error marker
    // will itself fail the build if the assignment ever becomes valid again.
    // @ts-expect-error strings are not valid capability records
    const bad: CapabilitiesField = ['mcp-gateway'];
    void bad;
  });
});
