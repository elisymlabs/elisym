/**
 * What a loader adds to the merchant page's global scope. It runs in a
 * sandbox holding only what loaders touch at load (no `document`: a loader
 * that reaches for it at load throws here), with `window` the sandbox itself
 * so `window.X = ...` lands where it is seen.
 */
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/** What each loader may add: v4 adds exactly `PayCore`, the others nothing. */
export const LOADER_GLOBALS: Readonly<Record<string, readonly string[]>> = {
  v1: [],
  v2: [],
  v3: [],
  v4: ['PayCore'],
};

/**
 * The globals `loader` adds, sorted; `top-level statements` when it is not one
 * expression statement (a top-level let, const or class is invisible to the
 * sandbox yet shares the page's global scope), `throws at load` when it fails.
 */
export function globalsAdded(loader: string): string[] {
  const sandbox: Record<string, unknown> = {
    customElements: { get: () => undefined, define: () => undefined },
    // Only extended, never constructed, when the loader runs.
    HTMLElement: Object,
    EventTarget: Object,
    URLSearchParams,
    console: { warn: () => undefined, error: () => undefined },
  };
  sandbox.window = sandbox;
  const before = new Set(Object.getOwnPropertyNames(sandbox));
  const added: string[] = [];
  try {
    runInNewContext(loader, sandbox);
  } catch {
    added.push('throws at load');
  }
  added.push(...Object.getOwnPropertyNames(sandbox).filter((name) => !before.has(name)));
  const program = ts.createSourceFile('embed.js', loader, ts.ScriptTarget.Latest);
  const oneExpression =
    program.statements.length === 1 && ts.isExpressionStatement(program.statements[0] as ts.Node);
  if (!oneExpression) {
    added.push('top-level statements');
  }
  return added.sort();
}

/** What is wrong with `version`'s globals; `undefined` when it adds exactly what it may. */
export function globalsProblem(version: string, loader: string): string | undefined {
  const expected = LOADER_GLOBALS[version];
  const added = globalsAdded(loader);
  if (expected !== undefined && added.join(',') === [...expected].sort().join(',')) {
    return undefined;
  }
  return `${version}/embed.js adds ${added.join(', ') || 'nothing'} to the page's global scope, not ${expected?.join(', ') || 'nothing'}`;
}
