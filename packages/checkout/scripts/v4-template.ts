import { join } from 'node:path';
import { build } from 'vite';

/** The v4 template built from its frozen source (nothing written to disk). */
export async function buildV4Template(packageDir: string): Promise<string> {
  const result = await build({
    configFile: join(packageDir, 'vite.embed-v4.config.ts'),
    logLevel: 'warn',
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if ('output' in output) {
      for (const chunk of output.output) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          return chunk.code;
        }
      }
    }
  }
  throw new Error('the v4 build produced no loader');
}
