import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ElisymYamlSchema } from '../src/agent-store/schema';

const SKILL_PATH = join(__dirname, '..', '..', '..', 'skills', 'elisym-config', 'SKILL.md');
const FIELDS_BEGIN = '<!-- fields:begin -->';
const FIELDS_END = '<!-- fields:end -->';

function extractDocumentedFields(markdown: string): string[] {
  const beginIdx = markdown.indexOf(FIELDS_BEGIN);
  const endIdx = markdown.indexOf(FIELDS_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      `skills/elisym-config/SKILL.md is missing the "${FIELDS_BEGIN}" / "${FIELDS_END}" anchors around the field table`,
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

describe('elisym-config skill ↔ ElisymYamlSchema drift', () => {
  it('documents exactly the top-level keys of ElisymYamlSchema', () => {
    const markdown = readFileSync(SKILL_PATH, 'utf-8');
    const documented = extractDocumentedFields(markdown).sort();
    const schemaKeys = Object.keys(ElisymYamlSchema.shape).sort();

    expect(documented).toEqual(schemaKeys);
  });
});
