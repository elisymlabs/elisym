/**
 * Disk-side loader for agent policies. Reads `<agent-root>/policies/*.md`,
 * parses optional YAML frontmatter, and returns validated policy records ready
 * to be passed to `PoliciesService.publishPolicy`.
 *
 * Filename without `.md` becomes the policy `type` slug (lowercase normalized).
 * Frontmatter fields are all optional - sensible defaults apply.
 *
 * Node.js only - relies on `node:fs` and `yaml`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { LIMITS, POLICY_TYPE_REGEX } from '../constants';

export interface LoadedPolicy {
  /** Slug derived from filename (e.g. `tos`, `privacy`, `refund`). */
  type: string;
  version: string;
  title: string;
  summary?: string;
  /** Markdown body without frontmatter. */
  content: string;
}

interface PolicyFrontmatter {
  title?: string;
  version?: string;
  summary?: string;
}

function humanizeType(type: string): string {
  return type
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseFrontmatter(raw: string): { frontmatter: PolicyFrontmatter; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: raw };
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    throw new Error('frontmatter opened with --- but never closed');
  }
  const yamlStr = lines.slice(1, endIndex).join('\n');
  const parsed = YAML.parse(yamlStr) as unknown;
  const frontmatter: PolicyFrontmatter =
    parsed !== null && typeof parsed === 'object' ? (parsed as PolicyFrontmatter) : {};
  const body = lines
    .slice(endIndex + 1)
    .join('\n')
    .replace(/^\n+/, '');
  return { frontmatter, body };
}

/**
 * Load all policy markdown files from `dir`. Returns an empty array if the
 * directory does not exist. Does not recurse into subdirectories.
 *
 * Edge cases:
 * - Skips non-`.md` files silently
 * - Logs a warning and skips files with malformed frontmatter or empty body
 * - Logs an error and skips files exceeding `MAX_POLICY_CONTENT_LENGTH`
 * - Throws if two files normalize to the same `type` slug (case-insensitive)
 * - At most `MAX_POLICIES_PER_AGENT` policies returned (alphabetical, rest skipped with warning)
 */
export function loadPoliciesFromDir(dir: string): LoadedPolicy[] {
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) {
      return [];
    }
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const mdFiles = entries
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));

  const seenTypes = new Set<string>();
  const loaded: LoadedPolicy[] = [];

  for (const filename of mdFiles) {
    const type = filename.slice(0, -'.md'.length).toLowerCase();
    if (!POLICY_TYPE_REGEX.test(type)) {
      console.warn(
        `  ! Skipping policy "${filename}": invalid type slug. Allowed: lowercase ASCII + hyphen, 1-${LIMITS.MAX_POLICY_TYPE_LENGTH} chars.`,
      );
      continue;
    }
    if (seenTypes.has(type)) {
      throw new Error(
        `Duplicate policy type "${type}" (case-insensitive collision in ${dir}). Policy filenames must be unique when lowercased.`,
      );
    }
    seenTypes.add(type);

    if (loaded.length >= LIMITS.MAX_POLICIES_PER_AGENT) {
      console.warn(
        `  ! Skipping policy "${filename}": agent has more than ${LIMITS.MAX_POLICIES_PER_AGENT} policies (cap).`,
      );
      continue;
    }

    const fullPath = join(dir, filename);
    let raw: string;
    try {
      raw = readFileSync(fullPath, 'utf-8');
    } catch (err) {
      console.warn(`  ! Skipping policy "${filename}": ${(err as Error).message}`);
      continue;
    }

    let frontmatter: PolicyFrontmatter;
    let body: string;
    try {
      const parsed = parseFrontmatter(raw);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch (err) {
      console.warn(`  ! Skipping policy "${filename}": ${(err as Error).message}`);
      continue;
    }

    const content = body.trim();
    if (content.length === 0) {
      console.warn(`  ! Skipping policy "${filename}": empty body.`);
      continue;
    }
    if (content.length > LIMITS.MAX_POLICY_CONTENT_LENGTH) {
      console.error(
        `  ! Skipping policy "${filename}": ${content.length} chars exceeds ${LIMITS.MAX_POLICY_CONTENT_LENGTH} limit.`,
      );
      continue;
    }

    const title =
      typeof frontmatter.title === 'string' && frontmatter.title.trim().length > 0
        ? frontmatter.title.trim().slice(0, LIMITS.MAX_POLICY_TITLE_LENGTH)
        : humanizeType(type);
    const version =
      typeof frontmatter.version === 'string' && frontmatter.version.trim().length > 0
        ? frontmatter.version.trim().slice(0, LIMITS.MAX_POLICY_VERSION_LENGTH)
        : '1.0';
    const summary =
      typeof frontmatter.summary === 'string' && frontmatter.summary.trim().length > 0
        ? frontmatter.summary.trim().slice(0, LIMITS.MAX_POLICY_SUMMARY_LENGTH)
        : undefined;

    loaded.push({ type, version, title, summary, content });
  }

  return loaded;
}
