/**
 * Init command - create a new agent.
 *
 * Usage:
 *   elisym init [name]                     Interactive wizard; creates in ~/.elisym/<name>/.
 *   elisym init [name] --config <path>     Non-interactive; loads YAML template.
 *   elisym init [name] --local             Create in project <project>/.elisym/<name>/.
 *   elisym init [name] --passphrase <p>    Skip passphrase prompt ("" = no encryption).
 *   elisym init [name] --yes               Skip overwrite/shadow confirm prompts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateAgentName, RELAYS } from '@elisym/sdk';
import {
  ElisymYamlSchema,
  createAgentDir,
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
  local?: boolean;
  passphrase?: string;
  yes?: boolean;
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

function pickTarget(options: InitOptions): AgentSource {
  return options.local ? 'project' : 'home';
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

  // Step 3: Shadow / overwrite checks. With --yes, overwrite fails closed
  // (never silently clobber secrets) while shadow / sibling-location prompts
  // take their recommended default.
  const target = pickTarget(options);
  const sameLocation =
    target === 'home' ? resolveInHome(agentName) : resolveInProject(agentName, cwd);
  if (sameLocation) {
    if (options.yes) {
      throw new Error(
        `Agent "${agentName}" already exists at ${sameLocation}. Refusing to overwrite secrets under --yes. Remove the directory first or choose a different name.`,
      );
    }
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
    if (!options.yes) {
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
    }
  } else if (target === 'home' && resolveInProject(agentName, cwd)) {
    if (!options.yes) {
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

  // Step 5: LLM API key for the default provider (from env, then reuse
  // prompt-collected key, else prompt).
  let defaultProviderKey: string | undefined;
  if (yaml.llm) {
    const envKey =
      yaml.llm.provider === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : process.env.OPENAI_API_KEY;
    if (envKey) {
      defaultProviderKey = envKey;
      console.log(
        `  Using ${yaml.llm.provider === 'anthropic' ? 'ANTHROPIC' : 'OPENAI'}_API_KEY from environment.`,
      );
    } else if (promptedApiKey) {
      defaultProviderKey = promptedApiKey;
    } else {
      const { apiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: `${yaml.llm.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key:`,
          mask: '*',
        },
      ]);
      defaultProviderKey = apiKey || undefined;
    }
  }

  // Step 5b: Optional API key for the OTHER provider, used by skills that
  // declare a `provider:` override in their SKILL.md. Skipped when running
  // from a YAML template (non-interactive); operators can supply per-provider
  // keys via env vars or by editing `.secrets.json` directly.
  let otherProviderKey: string | undefined;
  if (yaml.llm && !template) {
    const otherProvider: 'anthropic' | 'openai' =
      yaml.llm.provider === 'anthropic' ? 'openai' : 'anthropic';
    const otherProviderLabel = otherProvider === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const otherEnvVar = otherProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    const otherEnvKey = process.env[otherEnvVar];

    const { configureOther } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'configureOther',
        message: `Configure ${otherProviderLabel} API key too (for skills that override the default provider)?`,
        default: Boolean(otherEnvKey),
      },
    ]);
    if (configureOther) {
      if (otherEnvKey) {
        otherProviderKey = otherEnvKey;
        console.log(`  Using ${otherEnvVar} from environment.`);
      } else {
        const { promptedOther } = await inquirer.prompt([
          {
            type: 'password',
            name: 'promptedOther',
            message: `${otherProviderLabel} API key:`,
            mask: '*',
          },
        ]);
        otherProviderKey = promptedOther || undefined;
      }
    }
  }

  // Step 6: Passphrase for encrypting secrets. Flag wins over env var wins
  // over interactive prompt. Empty string ("") is an explicit opt-out from
  // encryption, distinct from "flag not provided".
  let passphrase = '';
  const envPassphrase = process.env.ELISYM_PASSPHRASE;
  if (options.passphrase !== undefined) {
    passphrase = options.passphrase;
  } else if (envPassphrase !== undefined) {
    passphrase = envPassphrase;
  } else {
    const answer = await inquirer.prompt([
      {
        type: 'password',
        name: 'passphrase',
        message: 'Passphrase to encrypt secrets (leave empty to skip):',
        mask: '*',
      },
    ]);
    passphrase = answer.passphrase ?? '';
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
  }

  // Step 7: Generate Nostr identity.
  const nostrSecretBytes = generateSecretKey();
  const nostrPubkey = getPublicKey(nostrSecretBytes);
  const nostrSecretHex = Buffer.from(nostrSecretBytes).toString('hex');

  // Step 8: Create agent directory + write files. Each provider's key lands
  // in its own per-provider field; the start-time resolver reads them
  // directly (or falls back to the matching env var).
  const created = await createAgentDir({ target, name: agentName, cwd });
  const anthropicKey = yaml.llm?.provider === 'anthropic' ? defaultProviderKey : otherProviderKey;
  const openaiKey = yaml.llm?.provider === 'openai' ? defaultProviderKey : otherProviderKey;
  await writeYaml(created.dir, yaml);
  await writeSecrets(
    created.dir,
    {
      nostr_secret_key: nostrSecretHex,
      anthropic_api_key: anthropicKey,
      openai_api_key: openaiKey,
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

  if (solanaAddress) {
    console.log(
      '  The wallet receives every asset on Solana (SOL directly, USDC and other\n' +
        '  SPL tokens via their ATA). Each skill declares its own price and token\n' +
        '  in SKILL.md. Fund with SOL via `solana airdrop` or USDC via https://faucet.circle.com.',
    );
  }

  const { llmProvider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'llmProvider',
      message: 'LLM provider:',
      choices: [
        {
          name: 'None (non-LLM agent - static-file / static-script / dynamic-script only)',
          value: 'none',
        },
        { name: 'Anthropic (Claude)', value: 'anthropic' },
        { name: 'OpenAI (GPT)', value: 'openai' },
      ],
    },
  ]);

  const baseYaml = {
    display_name: displayName || undefined,
    description,
    picture: picture || undefined,
    banner: banner || undefined,
    relays: [...RELAYS],
    payments: solanaAddress ? [{ chain: 'solana', network: 'devnet', address: solanaAddress }] : [],
    security: {},
  };

  if (llmProvider === 'none') {
    const yaml: ElisymYaml = ElisymYamlSchema.parse(baseYaml);
    return { yaml };
  }

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
    ...baseYaml,
    llm: { provider: llmProvider, model, max_tokens: maxTokens },
  });
  // envKey is returned only when the user explicitly typed it (not when
  // pulled from process.env) - the env-var path is handled in cmdInit Step 5.
  return { yaml, apiKey: envKey ? undefined : apiKey };
}
