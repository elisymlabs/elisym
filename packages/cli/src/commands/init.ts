/**
 * Init command - create a new agent.
 *
 * Usage:
 *   elisym init [name]                     Interactive wizard (prompts for all fields).
 *   elisym init [name] --config <path>     Non-interactive; loads YAML template.
 *   elisym init [name] --global            Force ~/.elisym/<name>/ layout.
 *   elisym init [name] --local             Force project .elisym/<name>/ layout.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateAgentName, RELAYS } from '@elisym/sdk';
import {
  ElisymYamlSchema,
  createAgentDir,
  findProjectElisymDir,
  resolveInHome,
  resolveInProject,
  writeSecrets,
  writeYaml,
  type AgentSource,
  type ElisymYaml,
} from '@elisym/sdk/agent-store';
import { isAddress } from '@solana/kit';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import YAML from 'yaml';

export interface InitOptions {
  config?: string;
  global?: boolean;
  local?: boolean;
}

const FALLBACK_MODELS: Record<string, string[]> = {
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
};

export async function fetchModels(provider: string, apiKey: string): Promise<string[]> {
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) {
        throw new Error(`${res.status}`);
      }
      const data = (await res.json()) as { data?: { id: string }[] };
      const models = (data.data ?? []).map((m) => m.id).sort();
      return models.length > 0 ? models : FALLBACK_MODELS.anthropic!;
    }
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        throw new Error(`${res.status}`);
      }
      const data = (await res.json()) as { data?: { id: string }[] };
      const models = (data.data ?? [])
        .map((m) => m.id)
        .filter(
          (id) =>
            (id.startsWith('gpt-') ||
              id.startsWith('o1') ||
              id.startsWith('o3') ||
              id.startsWith('o4') ||
              id.startsWith('chatgpt-')) &&
            !id.includes('instruct') &&
            !id.includes('realtime') &&
            !id.includes('audio') &&
            !id.includes('tts') &&
            !id.includes('whisper'),
        )
        .sort();
      return models.length > 0 ? models : FALLBACK_MODELS.openai!;
    }
    return ['gpt-4o'];
  } catch (e: any) {
    console.warn(`  ! Could not fetch models: ${e.message}. Using defaults.`);
    return FALLBACK_MODELS[provider] ?? ['gpt-4o'];
  }
}

function pickTarget(options: InitOptions, cwd: string): AgentSource {
  if (options.global) {
    return 'home';
  }
  if (options.local) {
    return 'project';
  }
  return findProjectElisymDir(cwd) ? 'project' : 'home';
}

export async function cmdInit(nameArg?: string, options: InitOptions = {}): Promise<void> {
  const { default: inquirer } = await import('inquirer');
  const cwd = process.cwd();

  console.log('\n  elisym agent setup\n');

  // Step 1: YAML template (optional).
  let template: ElisymYaml | undefined;
  if (options.config) {
    const configPath = resolve(cwd, options.config);
    const raw = readFileSync(configPath, 'utf-8');
    template = ElisymYamlSchema.parse(YAML.parse(raw) ?? {});
    console.log(`  Loaded template from ${configPath}\n`);
  }

  // Step 2: Agent name (arg > prompt).
  const agentName = await resolveAgentName(nameArg, inquirer);

  // Step 3: Shadow / overwrite checks.
  const target = pickTarget(options, cwd);
  const sameLocation =
    target === 'home' ? resolveInHome(agentName) : resolveInProject(agentName, cwd);
  if (sameLocation) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Agent "${agentName}" already exists at ${sameLocation}. Overwrite secrets?`,
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log('Aborted.');
      return;
    }
  } else if (target === 'project' && resolveInHome(agentName)) {
    const { shadow } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'shadow',
        message: `A global agent "${agentName}" exists in ~/.elisym/${agentName}/. Create a project-local shadow?`,
        default: true,
      },
    ]);
    if (!shadow) {
      console.log('Aborted.');
      return;
    }
  } else if (target === 'home' && resolveInProject(agentName, cwd)) {
    const { proceed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'proceed',
        message: `A project-local agent "${agentName}" exists. Create a global agent with the same name?`,
        default: true,
      },
    ]);
    if (!proceed) {
      console.log('Aborted.');
      return;
    }
  }

  // Step 4: Build YAML. If a template was loaded, reuse it; otherwise prompt
  // interactively. promptYaml also returns the API key it collected so we
  // don't re-prompt in Step 5.
  let yaml: ElisymYaml;
  let promptedApiKey: string | undefined;
  if (template) {
    yaml = template;
  } else {
    const result = await promptYaml(inquirer);
    yaml = result.yaml;
    promptedApiKey = result.apiKey;
  }

  // Step 5: LLM API key (from env, then reuse prompt-collected key, else prompt).
  let llmApiKey: string | undefined;
  if (yaml.llm) {
    const envKey =
      yaml.llm.provider === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : process.env.OPENAI_API_KEY;
    if (envKey) {
      llmApiKey = envKey;
      console.log(
        `  Using ${yaml.llm.provider === 'anthropic' ? 'ANTHROPIC' : 'OPENAI'}_API_KEY from environment.`,
      );
    } else if (promptedApiKey) {
      llmApiKey = promptedApiKey;
    } else {
      const { apiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: `${yaml.llm.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key:`,
          mask: '*',
        },
      ]);
      llmApiKey = apiKey || undefined;
    }
  }

  // Step 6: Passphrase for encrypting secrets.
  const { passphrase } = await inquirer.prompt([
    {
      type: 'password',
      name: 'passphrase',
      message: 'Passphrase to encrypt secrets (leave empty to skip):',
      mask: '*',
    },
  ]);

  if (passphrase) {
    const { confirmPassphrase } = await inquirer.prompt([
      {
        type: 'password',
        name: 'confirmPassphrase',
        message: 'Confirm passphrase:',
        mask: '*',
        validate: (value: string) => value === passphrase || 'Passphrases do not match',
      },
    ]);
    void confirmPassphrase;
  }

  // Step 7: Generate Nostr identity.
  const nostrSecretBytes = generateSecretKey();
  const nostrPubkey = getPublicKey(nostrSecretBytes);
  const nostrSecretHex = Buffer.from(nostrSecretBytes).toString('hex');

  // Step 8: Create agent directory + write files.
  const created = await createAgentDir({ target, name: agentName, cwd });
  await writeYaml(created.dir, yaml);
  await writeSecrets(
    created.dir,
    {
      nostr_secret_key: nostrSecretHex,
      llm_api_key: llmApiKey,
    },
    passphrase || undefined,
  );

  const npub = nip19.npubEncode(nostrPubkey);
  console.log(`\n  Agent "${agentName}" created (${target}).`);
  console.log(`  Location: ${created.dir}`);
  console.log(`  Nostr:    ${npub}`);
  if (yaml.payments[0]?.address) {
    console.log(`  Solana:   ${yaml.payments[0].address}`);
  }
  if (passphrase) {
    console.log('  Secrets encrypted with your passphrase.');
  }
  console.log();
}

async function resolveAgentName(
  nameArg: string | undefined,
  inquirer: { prompt: any },
): Promise<string> {
  if (nameArg) {
    validateAgentName(nameArg);
    return nameArg;
  }
  const { inputName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'inputName',
      message: 'Agent name:',
      validate: (value: string) => {
        try {
          validateAgentName(value);
          return true;
        } catch (e: any) {
          return e.message;
        }
      },
    },
  ]);
  validateAgentName(inputName);
  return inputName;
}

async function promptYaml(inquirer: {
  prompt: any;
}): Promise<{ yaml: ElisymYaml; apiKey?: string }> {
  const { description } = await inquirer.prompt([
    {
      type: 'input',
      name: 'description',
      message: 'Description:',
      default: 'An elisym AI agent',
    },
  ]);

  const { displayName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'displayName',
      message: 'Display name (optional, for UI):',
      default: '',
    },
  ]);

  const { picture } = await inquirer.prompt([
    {
      type: 'input',
      name: 'picture',
      message: 'Avatar file (relative to agent dir, e.g. ./avatar.png) or URL:',
      default: '',
    },
  ]);

  const { banner } = await inquirer.prompt([
    {
      type: 'input',
      name: 'banner',
      message: 'Banner file (relative to agent dir, e.g. ./header.png) or URL:',
      default: '',
    },
  ]);

  const { solanaAddress } = await inquirer.prompt([
    {
      type: 'input',
      name: 'solanaAddress',
      message: 'Solana address for receiving payments (leave empty to skip):',
      default: '',
      validate: (value: string) => {
        if (!value) {
          return true;
        }
        return isAddress(value) || 'Invalid Solana address';
      },
    },
  ]);

  const { llmProvider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'llmProvider',
      message: 'LLM provider:',
      choices: [
        { name: 'Anthropic (Claude)', value: 'anthropic' },
        { name: 'OpenAI (GPT)', value: 'openai' },
      ],
    },
  ]);

  const envKey =
    llmProvider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  let apiKey: string | undefined = envKey;
  if (!apiKey) {
    const { promptedKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'promptedKey',
        message: `${llmProvider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key:`,
        mask: '*',
      },
    ]);
    apiKey = promptedKey || undefined;
  }

  console.log('  Fetching available models...');
  const models = await fetchModels(llmProvider, apiKey ?? '');
  const { model } = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: 'Model:',
      choices: models,
    },
  ]);

  const { maxTokens } = await inquirer.prompt([
    {
      type: 'number',
      name: 'maxTokens',
      message: 'Max tokens:',
      default: 4096,
    },
  ]);

  const yaml: ElisymYaml = ElisymYamlSchema.parse({
    display_name: displayName || undefined,
    description,
    picture: picture || undefined,
    banner: banner || undefined,
    relays: [...RELAYS],
    payments: solanaAddress ? [{ chain: 'solana', network: 'devnet', address: solanaAddress }] : [],
    llm: { provider: llmProvider, model, max_tokens: maxTokens },
    security: {},
  });
  // envKey is returned only when the user explicitly typed it (not when
  // pulled from process.env) - the env-var path is handled in cmdInit Step 5.
  return { yaml, apiKey: envKey ? undefined : apiKey };
}
