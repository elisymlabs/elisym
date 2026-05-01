/**
 * Write agent files: elisym.yaml, .secrets.json, .gitignore, and create agent dirs.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { encryptSecret, isEncrypted } from '../primitives/encryption';
import { agentPaths, type AgentPaths } from './paths';
import { elisymRootFor, type AgentSource } from './resolver';
import { ElisymYamlSchema, SecretsSchema, type ElisymYaml, type Secrets } from './schema';
import { renderInitialYaml } from './template';

const GITIGNORE_CONTENT = [
  '# elisym private state - do not commit.',
  '.secrets.json',
  '.media-cache.json',
  '.jobs.json',
  '.jobs.json.corrupt.*',
  '.customer-history.json',
  '.contacts.json',
  '',
].join('\n');

export interface CreateAgentDirOptions {
  target: AgentSource;
  name: string;
  cwd: string;
  /**
   * For `target: 'project'`: if no .elisym/ dir exists above cwd,
   * where should we create one? Defaults to cwd.
   */
  projectRoot?: string;
}

export interface CreatedAgentDir {
  dir: string;
  paths: AgentPaths;
  source: AgentSource;
  createdNewElisymRoot: boolean;
}

/**
 * Create (or reuse) the directory layout for a new agent. Idempotent: if the
 * agent directory already exists, returns its paths without overwriting.
 * Writes `.gitignore` in project-local .elisym/ on first creation.
 */
export async function createAgentDir(options: CreateAgentDirOptions): Promise<CreatedAgentDir> {
  const { target, name, cwd, projectRoot } = options;

  const existingRoot = elisymRootFor(target, cwd);
  let elisymRoot: string;
  let createdNewElisymRoot = false;

  if (existingRoot) {
    elisymRoot = existingRoot;
  } else if (target === 'project') {
    elisymRoot = join(projectRoot ?? cwd, '.elisym');
    createdNewElisymRoot = true;
  } else {
    throw new Error('homeElisymDir should always exist conceptually - this is unreachable');
  }

  const agentDir = join(elisymRoot, name);
  const mode = target === 'home' ? 0o700 : 0o755;
  await mkdir(agentDir, { recursive: true, mode });
  await mkdir(join(agentDir, 'skills'), { recursive: true, mode });

  if (target === 'project') {
    const gitignorePath = join(elisymRoot, '.gitignore');
    await writeFileIfMissing(gitignorePath, GITIGNORE_CONTENT, 0o644);
  }

  return {
    dir: agentDir,
    paths: agentPaths(agentDir),
    source: target,
    createdNewElisymRoot,
  };
}

/** Write elisym.yaml atomically. Validates via Zod before writing. */
export async function writeYaml(agentDir: string, yaml: ElisymYaml): Promise<void> {
  const validated = ElisymYamlSchema.parse(yaml);
  const body = YAML.stringify(validated);
  const target = agentPaths(agentDir).yaml;
  await writeFileAtomic(target, body, 0o644);
}

/**
 * Write a brand-new elisym.yaml with descriptive header comments and
 * commented-out examples for unset optional fields. Use only at agent
 * creation time (CLI `init`, MCP `create_agent`). Subsequent edits go
 * through `writeYaml`, which discards comments.
 */
export async function writeYamlInitial(agentDir: string, yaml: ElisymYaml): Promise<void> {
  const validated = ElisymYamlSchema.parse(yaml);
  const body = renderInitialYaml(validated);
  const target = agentPaths(agentDir).yaml;
  await writeFileAtomic(target, body, 0o644);
}

/**
 * Create a skills directory placeholder file with a commented-out SKILL.md
 * template covering every supported field, so operators have a reference
 * for what they can declare without having to read source. The file is
 * named `EXAMPLE.md` (not `SKILL.md`) and lives directly in `skills/`
 * (not in a subdirectory), so the skill loader skips it - it's reference
 * material, not an active skill. To turn it into a real skill: copy it
 * into `skills/<your-skill-name>/SKILL.md` and uncomment the lines you
 * need.
 *
 * Idempotent: written with `wx` flag so we never overwrite an operator's
 * edits on re-run of `init`.
 */
export async function writeExampleSkillTemplate(agentDir: string): Promise<void> {
  const target = join(agentDir, 'skills', 'EXAMPLE.md');
  await writeFileIfMissing(target, EXAMPLE_SKILL_TEMPLATE, 0o644);
}

const EXAMPLE_SKILL_TEMPLATE = `# elisym skill template
#
# This is reference material, not an active skill. The agent runtime
# only loads skills from \`skills/<name>/SKILL.md\` (one folder per
# skill). To turn this template into a real skill:
#
#   1. mkdir skills/my-skill
#   2. cp skills/EXAMPLE.md skills/my-skill/SKILL.md
#   3. uncomment the fields you need and fill in real values
#   4. delete this comment block from the new file
#
# Full reference: see packages/cli/SKILLS.md in the elisym monorepo.

# ---
# # Required fields ---------------------------------------------------
#
# # Skill name. Must be unique within the agent. Used as the d-tag for
# # routing incoming jobs (NIP-89/NIP-90).
# name: My Skill
#
# # One-line description shown to customers in discovery UIs. Keep it
# # short and concrete - this is the "elevator pitch" for the skill.
# description: Send a prompt, get back a poem about it.
#
# # Capability tags. Customers filter and discover skills by these.
# # At least one entry required. Use lowercase kebab-case.
# capabilities:
#   - poetry
#   - text-generation
#
# # Price the customer pays per job. Number or numeric string. Free
# # skills (price: 0) are allowed only when the agent runtime is
# # configured with \`allowFreeSkills\`.
# price: 0.05
#
# # Asset the price is denominated in. Defaults to "sol" for back-compat
# # but USDC is the canonical paid-skill currency for examples.
# token: usdc
# # Optional explicit mint (base58). Resolved automatically for known
# # tokens, so usually omit this.
# # mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
#
# # Execution mode. Defaults to "llm" if omitted.
# # - llm:           feed input to an LLM with the system prompt below.
# # - static-file:   return the contents of a fixed file (no input read).
# # - static-script: spawn a script with no stdin (no input read).
# # - dynamic-script: spawn a script and pipe the customer's input to stdin.
# mode: llm
#
# # ---
# # LLM configuration / dependency -----------------------------------
# #
# # For mode: 'llm', \`provider\` + \`model\` override the agent default
# # for runtime LLM execution. \`max_tokens\` overrides the default cap.
# #
# # For script modes (static-script / dynamic-script / static-file):
# # \`provider\` + \`model\` declare which LLM API key the script
# # depends on. The agent registers the (provider, model) pair with
# # the health monitor so it can:
# #   - probe the key at startup (refuse to start on invalid/billing-out)
# #   - reactively flip the pair to unhealthy if the script exits with
# #     SCRIPT_EXIT_BILLING_EXHAUSTED (= 42), refusing future jobs
# #     before payment until the key recovers
# #   - run a 5-min lazy recovery probe loop that flips the pair back
# #     to healthy as soon as the key works again
# # \`max_tokens\` is rejected for script modes (the script controls
# # its own token limits).
# # provider: anthropic
# # model: claude-haiku-4-5-20251001
# # max_tokens: 4096
#
# # ---
# # mode-specific fields -------------------------------------------
#
# # Required when mode === 'static-file'.
# # output_file: ./output.txt
#
# # Required when mode === 'static-script' | 'dynamic-script'.
# # script: ./scripts/run.sh
# # script_args:
# #   - --flag
# #   - value
# # script_timeout_ms: 60000
#
# # ---
# # mode === 'llm' extras ------------------------------------------
# #
# # External tools the LLM can invoke during a job. Each tool is a
# # named subprocess; the LLM decides whether/when to call it.
# # tools:
# #   - name: lookup
# #     description: Look up a record by id.
# #     command:
# #       - ./tools/lookup.sh
# #     parameters:
# #       - name: id
# #         description: Record identifier (UUID).
# #         required: true
#
# # Cap on tool-use rounds (LLM <-> tools loop). Default 10.
# # max_tool_rounds: 10
#
# # ---
# # Per-skill rate limit (any mode) --------------------------------
# # Snake-case in YAML, applied by the runtime regardless of mode.
# # rate_limit:
# #   per_window_secs: 60
# #   max_per_window: 30
#
# # ---
# # Imagery ---------------------------------------------------------
# # Either a local file path (uploaded on first start) or an absolute
# # URL. Local paths must stay inside the skill directory.
# # image_file: ./skill-icon.png
# # image: https://example.com/icon.png
# ---
#
# Markdown body below the frontmatter is the system prompt for
# mode === 'llm'. For other modes it's ignored.
#
# You are a helpful assistant. Reply concisely.
`;

/**
 * Write .secrets.json atomically. If `passphrase` is given, encrypts all
 * plaintext secret fields (already-encrypted values are left as-is).
 * Generic over `llm_api_keys` so any registered provider's key is
 * encrypted without per-provider plumbing here.
 */
export async function writeSecrets(
  agentDir: string,
  secrets: Secrets,
  passphrase?: string,
): Promise<void> {
  const validated = SecretsSchema.parse(secrets);
  let encryptedLlmKeys: Record<string, string> | undefined;
  if (validated.llm_api_keys) {
    encryptedLlmKeys = {};
    for (const [providerId, value] of Object.entries(validated.llm_api_keys)) {
      if (value) {
        encryptedLlmKeys[providerId] = maybeEncrypt(value, passphrase);
      }
    }
    if (Object.keys(encryptedLlmKeys).length === 0) {
      encryptedLlmKeys = undefined;
    }
  }
  const finalSecrets: Secrets = {
    nostr_secret_key: maybeEncrypt(validated.nostr_secret_key, passphrase),
    solana_secret_key: validated.solana_secret_key
      ? maybeEncrypt(validated.solana_secret_key, passphrase)
      : undefined,
    llm_api_keys: encryptedLlmKeys,
  };
  const body = JSON.stringify(finalSecrets, null, 2) + '\n';
  const target = agentPaths(agentDir).secrets;
  await writeFileAtomic(target, body, 0o600);
}

function maybeEncrypt(value: string, passphrase: string | undefined): string {
  if (!passphrase) {
    return value;
  }
  if (isEncrypted(value)) {
    return value;
  }
  return encryptSecret(value, passphrase);
}

/** Atomic write: temp file + rename. Preserves mode. */
export async function writeFileAtomic(
  path: string,
  data: string | Buffer,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${randomBytes(6).toString('hex')}`;
  await writeFile(tmpPath, data, { mode });
  try {
    await rename(tmpPath, path);
  } catch (e) {
    // Best-effort cleanup of temp file on rename failure.
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

async function writeFileIfMissing(path: string, data: string, mode: number): Promise<void> {
  try {
    await writeFile(path, data, { mode, flag: 'wx' });
  } catch (e: unknown) {
    // wx fails with EEXIST if file exists - that's fine.
    if (!isEexist(e)) {
      throw e;
    }
  }
}

function isEexist(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'EEXIST'
  );
}
