/**
 * Profile command - edit agent profile, wallet, and LLM settings.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ElisymIdentity, MediaService } from '@elisym/sdk';
import { encryptSecret, isEncrypted } from '@elisym/sdk/node';
import { isAddress } from '@solana/kit';
import { loadConfig, saveConfig, listAgents } from '../config.js';

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
  return input;
}

export async function cmdProfile(name: string | undefined): Promise<void> {
  const { default: inquirer } = await import('inquirer');

  // Resolve agent name
  if (!name) {
    const agents = listAgents();
    if (agents.length === 0) {
      console.error('No agents found. Run `elisym init` first.');
      process.exit(1);
    }
    const { selected } = await inquirer.prompt([
      { type: 'list', name: 'selected', message: 'Select agent:', choices: agents },
    ]);
    name = selected;
  }

  const passphrase = process.env.ELISYM_PASSPHRASE;
  const config = loadConfig(name!, passphrase);
  const identity = ElisymIdentity.fromHex(config.identity.secret_key);

  console.log(`\n  Editing agent "${name}"\n`);

  // Menu loop
  let done = false;
  while (!done) {
    const { section } = await inquirer.prompt([
      {
        type: 'list',
        name: 'section',
        message: 'What to edit?',
        choices: [
          { name: `Profile (name: ${config.identity.name})`, value: 'profile' },
          {
            name: `Wallet (${config.payments?.[0]?.address ?? 'not configured'})`,
            value: 'wallet',
          },
          {
            name: `LLM (${config.llm?.provider ?? 'not configured'} / ${config.llm?.model ?? '-'})`,
            value: 'llm',
          },
          { name: 'Done', value: 'done' },
        ],
      },
    ]);

    if (section === 'done') {
      done = true;
      continue;
    }

    if (section === 'profile') {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'description',
          message: 'Description:',
          default: config.identity.description ?? '',
        },
        {
          type: 'input',
          name: 'picture',
          message: 'Avatar (URL or local path):',
          default: config.identity.picture ?? '',
        },
        {
          type: 'input',
          name: 'banner',
          message: 'Banner (URL or local path):',
          default: config.identity.banner ?? '',
        },
      ]);

      config.identity.description = answers.description || undefined;

      const media = new MediaService();
      if (answers.picture) {
        config.identity.picture = await resolveImage(answers.picture, identity, media);
      } else {
        config.identity.picture = undefined;
      }
      if (answers.banner) {
        config.identity.banner = await resolveImage(answers.banner, identity, media);
      } else {
        config.identity.banner = undefined;
      }

      saveConfig(config);
      console.log('  Profile updated.\n');
    }

    if (section === 'wallet') {
      const currentAddress = config.payments?.[0]?.address ?? '';
      const currentNetwork = config.payments?.[0]?.network ?? 'devnet';

      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'address',
          message: 'Solana address:',
          default: currentAddress,
          validate: (v: string) => {
            if (!v) {
              return true;
            }
            return isAddress(v) || 'Invalid Solana address';
          },
        },
        {
          type: 'list',
          name: 'network',
          message: 'Network:',
          choices: ['devnet', 'testnet', 'mainnet'],
          default: currentNetwork,
        },
      ]);

      if (answers.address) {
        config.payments = [{ chain: 'solana', network: answers.network, address: answers.address }];
      } else {
        config.payments = undefined;
      }

      saveConfig(config);
      console.log('  Wallet updated.\n');
    }

    if (section === 'llm') {
      const { llmProvider } = await inquirer.prompt([
        {
          type: 'list',
          name: 'llmProvider',
          message: 'LLM provider:',
          choices: [
            { name: 'Anthropic (Claude)', value: 'anthropic' },
            { name: 'OpenAI (GPT)', value: 'openai' },
          ],
          default: config.llm?.provider ?? 'anthropic',
        },
      ]);

      const { apiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: `API key (leave empty to keep current):`,
          mask: '*',
        },
      ]);

      const effectiveKey = apiKey || config.llm?.api_key || '';

      // Fetch models with the effective key
      let plainKey = effectiveKey;
      if (isEncrypted(plainKey) && passphrase) {
        const { decryptSecret } = await import('@elisym/sdk/node');
        plainKey = decryptSecret(plainKey, passphrase);
      }

      console.log('  Fetching available models...');
      const { fetchModels } = await import('./init.js');
      const models = await fetchModels(llmProvider, plainKey);

      const { model } = await inquirer.prompt([
        {
          type: 'list',
          name: 'model',
          message: 'Model:',
          choices: models,
          default: config.llm?.model,
        },
      ]);

      const { maxTokens } = await inquirer.prompt([
        {
          type: 'number',
          name: 'maxTokens',
          message: 'Max tokens:',
          default: config.llm?.max_tokens ?? 4096,
        },
      ]);

      const protect = (secret: string): string =>
        passphrase ? encryptSecret(secret, passphrase) : secret;

      config.llm = {
        provider: llmProvider,
        api_key: apiKey ? protect(apiKey) : effectiveKey,
        model,
        max_tokens: maxTokens,
      };

      saveConfig(config);
      console.log('  LLM updated.\n');
    }
  }

  console.log(`  Agent "${name}" saved.\n`);
}
