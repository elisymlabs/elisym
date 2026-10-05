import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '../src';

function built(file: string): string {
  return readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');
}

describe('the built package', () => {
  it('marks the component entry as client code', () => {
    for (const file of ['index.js', 'index.cjs']) {
      expect(built(file).startsWith("'use client';"), file).toBe(true);
    }
  });

  it('keeps the constants entry free of the client directive and of React', () => {
    for (const file of ['constants.js', 'constants.cjs']) {
      const code = built(file);
      expect(code, file).not.toContain('use client');
      expect(code, file).not.toContain('react');
      expect(code, file).toContain(V3_LOADER_SRC);
      expect(code, file).toContain(V3_LOADER_INTEGRITY);
    }
  });
});
