/**
 * Path helpers for .elisym/ layout.
 *
 * Project-local (walk up from CWD until .git or $HOME):
 *   <project>/.elisym/<name>/{elisym.yaml, .secrets.json, .media-cache.json, .jobs.json, .gitignore}
 *
 * Home-global (~/.elisym/<name>/): same file structure.
 *
 * Node.js only - relies on `node:fs`/`node:os`/`node:path`.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const ELISYM_DIRNAME = '.elisym';
export const YAML_FILENAME = 'elisym.yaml';
export const SECRETS_FILENAME = '.secrets.json';
export const MEDIA_CACHE_FILENAME = '.media-cache.json';
export const JOBS_FILENAME = '.jobs.json';
export const GITIGNORE_FILENAME = '.gitignore';
export const SKILLS_DIRNAME = 'skills';
export const POLICIES_DIRNAME = 'policies';

/** Max depth for walk-up search (safety guard against unbounded loops). */
const MAX_WALK_UP_DEPTH = 64;

/** ~/.elisym/ */
export function homeElisymDir(): string {
  return join(homedir(), ELISYM_DIRNAME);
}

/** ~/.elisym/config.yaml — global (not per-agent) config file. */
export function globalConfigPath(): string {
  return join(homeElisymDir(), 'config.yaml');
}

/**
 * Walk up from `startDir` looking for `.elisym/` directory.
 * Stops at (a) the first `.git` directory/file, (b) `$HOME`, (c) filesystem root,
 * or (d) MAX_WALK_UP_DEPTH iterations. Returns absolute path or null.
 */
export function findProjectElisymDir(startDir: string): string | null {
  const home = homedir();
  let current = resolve(startDir);
  let previous: string | null = null;

  for (let depth = 0; depth < MAX_WALK_UP_DEPTH; depth++) {
    if (current === previous) {
      return null;
    }

    // At $HOME: ~/.elisym/ is the home-global layout, not a project-local one.
    // Stop without matching to avoid misclassifying home agents as project.
    if (current === home) {
      return null;
    }

    const elisymCandidate = join(current, ELISYM_DIRNAME);
    if (existsSync(elisymCandidate) && safeIsDir(elisymCandidate)) {
      return elisymCandidate;
    }

    const gitCandidate = join(current, '.git');
    if (existsSync(gitCandidate)) {
      return null;
    }

    previous = current;
    current = dirname(current);
  }

  return null;
}

export interface AgentPaths {
  dir: string;
  yaml: string;
  secrets: string;
  mediaCache: string;
  jobs: string;
  gitignore: string;
  skills: string;
  policies: string;
}

/** Compute all file/dir paths for an agent given its root directory. */
export function agentPaths(agentDir: string): AgentPaths {
  return {
    dir: agentDir,
    yaml: join(agentDir, YAML_FILENAME),
    secrets: join(agentDir, SECRETS_FILENAME),
    mediaCache: join(agentDir, MEDIA_CACHE_FILENAME),
    jobs: join(agentDir, JOBS_FILENAME),
    gitignore: join(agentDir, GITIGNORE_FILENAME),
    skills: join(agentDir, SKILLS_DIRNAME),
    policies: join(agentDir, POLICIES_DIRNAME),
  };
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
