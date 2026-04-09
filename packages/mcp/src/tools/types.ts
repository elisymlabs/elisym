/**
 * ToolDefinition - the building block for modular tool registration.
 */
import type { z } from 'zod';
import type { AgentContext } from '../context.js';

/**
 * Shape of a tool handler return value. Structurally compatible with MCP's
 * `CallToolResult` (the index signature makes it assignable without a cast).
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * Tool definition stored in the registry. The schema generic is erased here because
 * TypeScript generics are invariant and a heterogeneous array of `ToolDefinition<Schema>`
 * variants can't be assigned to a single `ToolDefinition<...>[]`.
 *
 * Precise per-tool type checking is enforced at the *construction* site via `defineTool`
 * (below), not at the registry boundary.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: (ctx: AgentContext, input: unknown) => Promise<ToolResult>;
}

/**
 * Construct a `ToolDefinition` while keeping `handler` type-checked against the exact
 * schema generic.
 *
 * the callable's input parameter is typed as `z.infer<S>` so passing a mismatched
 * shape (e.g. `string[]` where `Capability[]` is expected) fails at compile time. The
 * cast to `ToolDefinition` at the return is the only place where the generic is erased,
 * and it is safe because we validated the handler signature against the schema.
 */
export function defineTool<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (ctx: AgentContext, input: z.infer<S>) => Promise<ToolResult>;
}): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/** Helper to create a successful text result. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Helper to create an error text result. */
export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
