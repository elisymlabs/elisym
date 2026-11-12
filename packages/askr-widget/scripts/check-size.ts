/**
 * Fails the build when `dist/widget.js` is over its budget (6: 80 KB gzip) or
 * when model text could reach `innerHTML`-style sinks anywhere in the source.
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

export function widgetGzipBytes(path: string = join(PACKAGE_DIR, 'dist', 'widget.js')): number {
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
  problems.push(...sinkProblems());
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}

export { WIDGET_BUDGET_BYTES };
