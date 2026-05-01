import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ElisymYamlSchema } from '../src/agent-store/schema';

const SKILL_PATH = join(__dirname, '..', '..', '..', 'skills', 'elisym-config', 'SKILL.md');
const README_PATH = join(__dirname, '..', 'README.md');
const FIELDS_BEGIN = '<!-- fields:begin -->';
const FIELDS_END = '<!-- fields:end -->';

function extractDocumentedFields(markdown: string, source: string): string[] {
  const beginIdx = markdown.indexOf(FIELDS_BEGIN);
  const endIdx = markdown.indexOf(FIELDS_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      `${source} is missing the "${FIELDS_BEGIN}" / "${FIELDS_END}" anchors around the field table`,
    );
  }
  const block = markdown.slice(beginIdx + FIELDS_BEGIN.length, endIdx);
  const fields: string[] = [];
  for (const line of block.split('\n')) {
    const match = line.match(/^\s*\|\s*`([^`]+)`\s*\|/);
    if (match) {
      fields.push(match[1]);
    }
  }
  return fields;
}

describe('docs ↔ ElisymYamlSchema drift', () => {
  const schemaKeys = Object.keys(ElisymYamlSchema.shape).sort();

  it('skills/elisym-config/SKILL.md documents exactly the top-level keys', () => {
    const markdown = readFileSync(SKILL_PATH, 'utf-8');
    const documented = extractDocumentedFields(markdown, 'skills/elisym-config/SKILL.md').sort();
    expect(documented).toEqual(schemaKeys);
  });

  it('packages/sdk/README.md documents exactly the top-level keys', () => {
    const markdown = readFileSync(README_PATH, 'utf-8');
    const documented = extractDocumentedFields(markdown, 'packages/sdk/README.md').sort();
    expect(documented).toEqual(schemaKeys);
  });
});
