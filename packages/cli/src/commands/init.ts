/**
 * Init command - interactive wizard to create a new agent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ElisymIdentity, MediaService, RELAYS } from '@elisym/sdk';
import { encryptSecret } from '@elisym/sdk/node';
import { PublicKey } from '@solana/web3.js';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { saveConfig, listAgents, validateAgentName, type AgentConfig } from '../config.js';

/** Resolve an image input: if local file exists, upload via MediaService; otherwise treat as URL. */
async function resolveImage(
  input: string,
  identity: ElisymIdentity,
  media: MediaService,
): Promise<string> {
  if (!input) {
    return '';
  }
  if (existsSync(input)) {
    console.log(`  Uploading ${basename(input)}...`);
    const data = readFileSync(input);
    const blob = new Blob([data]);
    const url = await media.upload(identity, blob, basename(input));
    console.log(`  Uploaded: ${url}`);
    return url;
  }
  // Not a file - treat as URL
  return input;
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

export async function cmdInit(): Promise<void> {
  const { default: inquirer } = await import('inquirer');

  console.log('\n  elisym agent setup\n');

  // Step 1: Agent name
  const { name } = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Agent name:',
      validate: (v: string) => {
        try {
          validateAgentName(v);
          return true;
        } catch (e: any) {
          return e.message;
        }
      },
    },
  ]);

  const existing = listAgents();
  if (existing.includes(name)) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Agent "${name}" already exists. Overwrite?`,
        default: false,
      },
    ]);
    if (!overwrite) {
      console.log('Aborted.');
      return;
    }
  }

  // Step 2: Description
  const { description } = await inquirer.prompt([
    {
      type: 'input',
      name: 'description',
      message: 'Description:',
      default: 'An elisym AI agent',
    },
  ]);

  // Step 2b: Profile images (local path or URL)
  const { pictureInput } = await inquirer.prompt([
    {
      type: 'input',
      name: 'pictureInput',
      message: 'Avatar image (URL or local path, optional):',
      default: '',
    },
  ]);

  const { bannerInput } = await inquirer.prompt([
    {
      type: 'input',
      name: 'bannerInput',
      message: 'Banner image (URL or local path, optional):',
      default: '',
    },
  ]);

  // Step 3: Solana address
  const { solanaAddress } = await inquirer.prompt([
    {
      type: 'input',
      name: 'solanaAddress',
      message: 'Solana address for receiving payments (leave empty to skip):',
      default: '',
      validate: (v: string) => {
        if (!v) {
          return true;
        }
        try {
          const pk = new PublicKey(v);
          return pk.toBase58().length > 0;
        } catch {
          return 'Invalid Solana address';
        }
      },
    },
  ]);

  // Step 4b: Solana network
  const { network } = await inquirer.prompt([
    {
      type: 'list',
      name: 'network',
      message: 'Solana network:',
      choices: [
        { name: 'devnet', value: 'devnet' },
        { name: 'testnet', value: 'testnet' },
        { name: 'mainnet', value: 'mainnet' },
      ],
      default: 'devnet',
    },
  ]);

  // Step 5: LLM provider
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

  // Step 6: API key
  const { apiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: `${llmProvider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key:`,
      mask: '*',
    },
  ]);

  // Step 7: Model (fetch from API, fallback to hardcoded)
  console.log('  Fetching available models...');
  const models = await fetchModels(llmProvider, apiKey);
  const { model } = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: 'Model:',
      choices: models,
    },
  ]);

  // Step 8: Max tokens
  const { maxTokens } = await inquirer.prompt([
    {
      type: 'number',
      name: 'maxTokens',
      message: 'Max tokens:',
      default: 4096,
    },
  ]);

  // Step 9: Passphrase for encrypting secrets
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
        validate: (v: string) => (v === passphrase ? true : 'Passphrases do not match'),
      },
    ]);
    void confirmPassphrase;
  }

  // Generate Nostr identity
  const nostrSecretKey = generateSecretKey();
  const nostrPubkey = getPublicKey(nostrSecretKey);
  const nostrSecretHex = Buffer.from(nostrSecretKey).toString('hex');
  const identity = ElisymIdentity.fromHex(nostrSecretHex);

  // Upload local images if needed
  const media = new MediaService();
  let picture = '';
  let banner = '';

  if (pictureInput || bannerInput) {
    console.log();
    if (pictureInput) {
      picture = await resolveImage(pictureInput, identity, media);
    }
    if (bannerInput) {
      banner = await resolveImage(bannerInput, identity, media);
    }
  }

  // Helper to optionally encrypt a secret
  const protect = (secret: string): string =>
    passphrase ? encryptSecret(secret, passphrase) : secret;

  const config: AgentConfig = {
    identity: {
      secret_key: protect(nostrSecretHex),
      name,
      description,
      picture: picture || undefined,
      banner: banner || undefined,
    },
    relays: [...RELAYS],
    payments: solanaAddress ? [{ chain: 'solana', network, address: solanaAddress }] : undefined,
    llm: {
      provider: llmProvider,
      api_key: protect(apiKey),
      model,
      max_tokens: maxTokens,
    },
  };

  saveConfig(config);

  const npub = nip19.npubEncode(nostrPubkey);
  console.log(`\n  Agent "${name}" created.`);
  console.log(`  Nostr:  ${npub}`);
  if (solanaAddress) {
    console.log(`  Solana: ${solanaAddress}`);
  }
  if (passphrase) {
    console.log('  Secrets encrypted with your passphrase.');
  }
  console.log(`  Config: ~/.elisym/agents/${name}/config.json\n`);
}
