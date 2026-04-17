/**
 * Agent resolution: find <name>/elisym.yaml via project-local walk-up, fallback to home.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ELISYM_DIRNAME, YAML_FILENAME, findProjectElisymDir, homeElisymDir } from './paths';

export type AgentSource = 'project' | 'home';

export interface ResolvedAgent {
  name: string;
  dir: string;
  source: AgentSource;
  /** true when both a project-local and a home-global agent exist with the same name. */
  shadowsGlobal: boolean;
}

/**
 * Resolve an agent by name. Precedence: project-local beats home-global.
 * Returns null if not found in either location.
 */
export function resolveAgent(name: string, cwd: string): ResolvedAgent | null {
  const projectDir = resolveInProject(name, cwd);
  const homeDir = resolveInHome(name);

  if (projectDir) {
    return {
      name,
      dir: projectDir,
      source: 'project',
      shadowsGlobal: homeDir !== null,
    };
  }

  if (homeDir) {
    return { name, dir: homeDir, source: 'home', shadowsGlobal: false };
  }

  return null;
}

/** Return project-local agent dir if its YAML exists, else null. */
export function resolveInProject(name: string, cwd: string): string | null {
  const projectElisym = findProjectElisymDir(cwd);
  if (!projectElisym) {
    return null;
  }
  const agentDir = join(projectElisym, name);
  const yamlPath = join(agentDir, YAML_FILENAME);
  return existsSync(yamlPath) ? agentDir : null;
}

/** Return home-global agent dir if its YAML exists, else null. */
export function resolveInHome(name: string): string | null {
  const agentDir = join(homeElisymDir(), name);
  const yamlPath = join(agentDir, YAML_FILENAME);
  return existsSync(yamlPath) ? agentDir : null;
}

/** Path to the .elisym root (project or home) for a given target. */
export function elisymRootFor(target: AgentSource, cwd: string): string | null {
  if (target === 'home') {
    return homeElisymDir();
  }
  return findProjectElisymDir(cwd);
}

/** Re-export for convenience. */
export { ELISYM_DIRNAME };
