/**
 * List all agents discoverable from the current working directory:
 *   - project-local: nearest .elisym/ (walk up to first .git or $HOME)
 *   - home-global: ~/.elisym/
 * Project-local entries shadow home-global entries with the same name.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { findProjectElisymDir, homeElisymDir, YAML_FILENAME } from './paths';
import type { AgentSource } from './resolver';
import { ElisymYamlSchema } from './schema';

export interface ListedAgent {
  name: string;
  source: AgentSource;
  dir: string;
  /** display_name from YAML, if present. */
  displayName?: string;
  /** true when this entry is project-local and a home-global agent with the same name exists. */
  shadowsGlobal: boolean;
}

/** List agents in both locations, deduping by name (project wins). */
export async function listAgents(cwd: string): Promise<ListedAgent[]> {
  const homeDir = homeElisymDir();
  const projectDir = findProjectElisymDir(cwd);

  const homeAgents = await listAgentsInDir(homeDir, 'home');
  const projectAgents = projectDir ? await listAgentsInDir(projectDir, 'project') : [];

  const homeNames = new Set(homeAgents.map((agent) => agent.name));

  const merged: ListedAgent[] = [];

  for (const entry of projectAgents) {
    merged.push({ ...entry, shadowsGlobal: homeNames.has(entry.name) });
  }
  const projectNames = new Set(projectAgents.map((agent) => agent.name));
  for (const entry of homeAgents) {
    if (!projectNames.has(entry.name)) {
      merged.push(entry);
    }
  }

  merged.sort((left, right) => left.name.localeCompare(right.name));
  return merged;
}

async function listAgentsInDir(rootDir: string, source: AgentSource): Promise<ListedAgent[]> {
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return [];
  }

  const results: ListedAgent[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue;
    }
    const agentDir = join(rootDir, entry);
    const yamlPath = join(agentDir, YAML_FILENAME);
    const displayName = await tryReadDisplayName(yamlPath);
    if (displayName === null) {
      continue;
    }
    results.push({
      name: entry,
      source,
      dir: agentDir,
      displayName: displayName || undefined,
      shadowsGlobal: false,
    });
  }

  return results;
}

/**
 * Read display_name from a YAML file. Returns null if the file is missing
 * or cannot be parsed (agent directory is skipped in listings).
 */
async function tryReadDisplayName(yamlPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(yamlPath, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = YAML.parse(raw);
    const yaml = ElisymYamlSchema.partial().safeParse(parsed ?? {});
    if (!yaml.success) {
      return '';
    }
    return yaml.data.display_name ?? '';
  } catch {
    return '';
  }
}
