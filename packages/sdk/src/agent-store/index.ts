/**
 * @elisym/sdk/agent-store - source of truth for elisym agent storage.
 *
 * Layout:
 *   <project>/.elisym/<name>/{elisym.yaml, .secrets.json, .media-cache.json, .jobs.json, skills/}
 *   ~/.elisym/<name>/{same files}
 *
 * Discovery:
 *   project-local wins over home-global. Walk up from CWD to first .git or $HOME.
 *
 * Node.js/Bun only. Not browser-safe (reads filesystem, uses crypto).
 */

// --- Schemas ---
export {
  ElisymYamlSchema,
  SecretsSchema,
  PaymentSchema,
  LlmSchema,
  SecurityFlagsSchema,
  MediaCacheSchema,
  MediaCacheEntrySchema,
  AgentNameSchema,
} from './schema';
export type {
  ElisymYaml,
  Secrets,
  PaymentEntry,
  LlmEntry,
  SecurityFlags,
  MediaCache,
  MediaCacheEntry,
} from './schema';

// --- Paths ---
export {
  ELISYM_DIRNAME,
  YAML_FILENAME,
  SECRETS_FILENAME,
  MEDIA_CACHE_FILENAME,
  JOBS_FILENAME,
  GITIGNORE_FILENAME,
  SKILLS_DIRNAME,
  POLICIES_DIRNAME,
  homeElisymDir,
  globalConfigPath,
  findProjectElisymDir,
  agentPaths,
} from './paths';
export type { AgentPaths } from './paths';

// --- Resolver ---
export { resolveAgent, resolveInProject, resolveInHome, elisymRootFor } from './resolver';
export type { AgentSource, ResolvedAgent } from './resolver';

// --- Loader ---
export { loadAgent, loadResolvedAgent, readAgentPublic } from './loader';
export type { LoadedAgent } from './loader';

// --- Writer ---
export {
  createAgentDir,
  writeYaml,
  writeYamlInitial,
  writeSecrets,
  writeFileAtomic,
  writeExampleSkillTemplate,
} from './writer';
export type { CreateAgentDirOptions, CreatedAgentDir } from './writer';

// --- Template ---
export { renderInitialYaml } from './template';

// --- List ---
export { listAgents } from './list';
export type { ListedAgent } from './list';

// --- Media cache ---
export {
  readMediaCache,
  writeMediaCache,
  hashFile,
  lookupCachedUrl,
  newCacheEntry,
} from './media-cache';

// --- Policies (disk loader) ---
export { loadPoliciesFromDir } from './policies';
export type { LoadedPolicy } from './policies';
