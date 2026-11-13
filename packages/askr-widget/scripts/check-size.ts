/**
 * Fails the build when `dist/widget.js` is over its budget (6: 80 KB gzip),
 * when model text could reach `innerHTML`-style sinks anywhere in the source,
 * or when the bundle would load more code at run time: a pinned `widget.js`
 * with `integrity` (6) covers only itself, so it must load nothing else.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WIDGET_BUDGET_BYTES = 80 * 1024;
const FORBIDDEN_SINKS: readonly string[] = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
];

/** Ways a bundle could load code its own `integrity` does not cover. */
const LAZY_LOADS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'a dynamic import()', pattern: /\bimport\s*\(/ },
  { name: 'importScripts()', pattern: /\bimportScripts\s*\(/ },
  { name: 'a worker', pattern: /\bnew\s+(?:Shared)?Worker\s*\(/ },
  { name: 'a script element', pattern: /createElement\(\s*["'`]script["'`]\s*\)/ },
];

const WIDGET_PATH = join(PACKAGE_DIR, 'dist', 'widget.js');

export function lazyLoadProblems(bundle: string = readFileSync(WIDGET_PATH, 'utf8')): string[] {
  return LAZY_LOADS.filter((load) => load.pattern.test(bundle)).map(
    (load) => `widget.js loads more code: ${load.name}`,
  );
}

export function widgetGzipBytes(path: string = WIDGET_PATH): number {
  return gzipSync(readFileSync(path)).length;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

export function sinkProblems(directory: string = join(PACKAGE_DIR, 'src')): string[] {
  return sourceFiles(directory).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return FORBIDDEN_SINKS.filter((sink) => source.includes(sink)).map(
      (sink) => `${file} uses ${sink}`,
    );
  });
}

if (import.meta.main) {
  const problems: string[] = [];
  const size = widgetGzipBytes();
  console.log(
    `widget.js  ${(size / 1024).toFixed(1)} KB gzip (budget ${WIDGET_BUDGET_BYTES / 1024})`,
  );
  if (size > WIDGET_BUDGET_BYTES) {
    problems.push('widget.js is over its 80 KB gzip budget');
  }
  problems.push(...sinkProblems(), ...lazyLoadProblems());
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}

export { WIDGET_BUDGET_BYTES };
