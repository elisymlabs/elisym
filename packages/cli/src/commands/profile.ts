import type { Network } from '@elisym/sdk';
import {
  listAgents,
  loadAgent,
  writeSecrets,
  writeYaml,
  type ElisymYaml,
  type LlmEntry,
  type Secrets,
} from '@elisym/sdk/agent-store';
/**
 * Profile command - edit agent profile, wallet, and LLM settings.
 * Writes back to elisym.yaml (public) and .secrets.json (private).
 */
import { isAddress } from '@solana/kit';
import { getLlmProvider, listLlmProviders } from '../llm';

export async function cmdProfile(name: string | undefined): Promise<void> {
  const { default: inquirer } = await import('inquirer');
  const cwd = process.cwd();

  if (!name) {
    const agents = await listAgents(cwd);
    if (agents.length === 0) {
      console.error('No agents found. Run `npx @elisym/cli init` first.');
      process.exit(1);
    }
    const { selected } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selected',
        message: 'Select agent:',
        choices: agents.map((agent) => ({
          name: `${agent.name} (${agent.source})`,
          value: agent.name,
        })),
      },
    ]);
    name = selected;
  }

  const passphrase = process.env.ELISYM_PASSPHRASE;
  const loaded = await loadAgent(name!, cwd, passphrase);

  console.log(`\n  Editing agent "${name}" (${loaded.source})\n`);

  let done = false;
  while (!done) {
    const { section } = await inquirer.prompt([
      {
        type: 'list',
        name: 'section',
        message: 'What to edit?',
        choices: [
          {
            name: `Profile (description: ${truncate(loaded.yaml.description ?? '')})`,
            value: 'profile',
          },
          {
            name: `Wallet (${loaded.yaml.payments[0]?.address ?? 'not configured'})`,
            value: 'wallet',
          },
          {
            name: `LLM (${loaded.yaml.llm?.provider ?? 'not configured'} / ${loaded.yaml.llm?.model ?? '-'})`,
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
          name: 'displayName',
          message: 'Display name (for UI):',
          default: loaded.yaml.display_name ?? '',
        },
        {
          type: 'input',
          name: 'description',
          message: 'Description:',
          default: loaded.yaml.description ?? '',
        },
        {
          type: 'input',
          name: 'picture',
          message: 'Avatar (relative path or URL, empty to clear):',
          default: loaded.yaml.picture ?? '',
        },
        {
          type: 'input',
          name: 'banner',
          message: 'Banner (relative path or URL, empty to clear):',
          default: loaded.yaml.banner ?? '',
        },
      ]);

      const nextYaml: ElisymYaml = {
        ...loaded.yaml,
        display_name: answers.displayName || undefined,
        description: answers.description ?? '',
        picture: answers.picture || undefined,
        banner: answers.banner || undefined,
      };
      await writeYaml(loaded.dir, nextYaml);
      loaded.yaml = nextYaml;
      console.log('  Profile updated.\n');
    }

    if (section === 'wallet') {
      const current = loaded.yaml.payments.find((entry) => entry.chain === 'solana');
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'address',
          message: current ? 'Solana address:' : 'Solana address (empty to skip):',
          default: current?.address ?? '',
          validate: (value: string) => {
            if (!value) {
              return true;
            }
            return isAddress(value) || 'Invalid Solana address';
          },
        },
      ]);

      // Refuse to remove an existing wallet entry: the entry carries the
      // agent's network, and network is fixed at creation (D1). Allowing a
      // clear here would lose that pin - a later re-add (or `x402 add`) would
      // prompt for a network again, silently flipping the agent between
      // devnet and mainnet under the same identity and capability d-tags.
      if (!answers.address && current) {
        console.log(
          '  ! The wallet entry cannot be removed: it pins the agent network, which is\n' +
            '    fixed at creation - to change networks, create a new agent. To stop\n' +
            '    charging, set every skill price to 0 instead. Wallet unchanged.\n',
        );
        continue;
      }

      // An existing entry's network is kept, never re-asked: network is fixed
      // at agent creation (D1) - to go mainnet, create a new agent. Only a
      // first-time wallet setup chooses one (default devnet, D12).
      let walletNetwork: Network | undefined = current?.network;
      if (answers.address && walletNetwork === undefined) {
        const { network } = await inquirer.prompt([
          {
            type: 'list',
            name: 'network',
            message: 'Solana network (fixed once set - to switch later, create a new agent):',
            choices: [
              { name: 'devnet (test tokens - recommended to start)', value: 'devnet' },
              { name: 'mainnet (REAL funds)', value: 'mainnet' },
            ],
            default: 'devnet',
          },
        ]);
        walletNetwork = network as Network;
        if (walletNetwork === 'mainnet') {
          console.log(
            '  ! MAINNET: this wallet handles REAL funds - every skill price is real money\n' +
              '    and there is no faucet. Strongly consider encrypting secrets with a passphrase.',
          );
        }
      }

      // Replace only the Solana entry - preserve entries for any other chain
      // so a future multi-chain payments[] is not clobbered by a wallet edit.
      const otherChainEntries = loaded.yaml.payments.filter((entry) => entry.chain !== 'solana');
      const nextYaml: ElisymYaml = {
        ...loaded.yaml,
        payments:
          answers.address && walletNetwork !== undefined
            ? [
                ...otherChainEntries,
                { chain: 'solana', network: walletNetwork, address: answers.address },
              ]
            : otherChainEntries,
      };
      await writeYaml(loaded.dir, nextYaml);
      loaded.yaml = nextYaml;
      console.log('  Wallet updated.\n');
    }

    if (section === 'llm') {
      const providerChoices = listLlmProviders().map((descriptor) => ({
        name: descriptor.displayName,
        value: descriptor.id,
      }));
      if (providerChoices.length === 0) {
        console.error('  ! No LLM providers registered.');
        continue;
      }
      const firstChoice = providerChoices[0];
      if (!firstChoice) {
        console.error('  ! No LLM providers registered.');
        continue;
      }
      const { llmProvider } = await inquirer.prompt([
        {
          type: 'list',
          name: 'llmProvider',
          message: 'Default LLM provider (used by skills without a `provider:` override):',
          choices: providerChoices,
          default: loaded.yaml.llm?.provider ?? firstChoice.value,
        },
      ]);
      const defaultDescriptor = getLlmProvider(llmProvider);
      if (!defaultDescriptor) {
        throw new Error(`Internal: provider "${llmProvider}" not registered.`);
      }

      const defaultKeyStatus = describeKeyStatus(loaded.secrets, llmProvider);
      const { apiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: `${defaultDescriptor.displayName} API key [${defaultKeyStatus}] (leave empty to keep current):`,
          mask: '*',
        },
      ]);

      const probeKey = apiKey || pickPlainKey(loaded.secrets, llmProvider);

      console.log('  Fetching available models...');
      const { fetchModels } = await import('./init.js');
      const models = await fetchModels(llmProvider, probeKey);

      const { model } = await inquirer.prompt([
        {
          type: 'list',
          name: 'model',
          message: 'Model:',
          choices: models,
          default: loaded.yaml.llm?.model,
        },
      ]);

      const { maxTokens } = await inquirer.prompt([
        {
          type: 'number',
          name: 'maxTokens',
          message: 'Max tokens:',
          default: loaded.yaml.llm?.max_tokens ?? 4096,
        },
      ]);

      // Optional keys for OTHER registered providers (used by skills
      // that override the default provider in their SKILL.md).
      const otherDescriptors = listLlmProviders().filter(
        (descriptor) => descriptor.id !== llmProvider,
      );
      const otherKeys = new Map<string, string>();
      for (const descriptor of otherDescriptors) {
        const status = describeKeyStatus(loaded.secrets, descriptor.id);
        const { otherApiKey } = await inquirer.prompt([
          {
            type: 'password',
            name: 'otherApiKey',
            message: `${descriptor.displayName} API key for skill overrides [${status}] (leave empty to keep current):`,
            mask: '*',
          },
        ]);
        if (otherApiKey) {
          otherKeys.set(descriptor.id, otherApiKey);
        }
      }

      const nextLlm: LlmEntry = { provider: llmProvider, model, max_tokens: maxTokens };
      const nextYaml: ElisymYaml = { ...loaded.yaml, llm: nextLlm };
      await writeYaml(loaded.dir, nextYaml);
      loaded.yaml = nextYaml;

      if (apiKey || otherKeys.size > 0) {
        const nextLlmApiKeys: Record<string, string> = {
          ...(loaded.secrets.llm_api_keys ?? {}),
        };
        if (apiKey) {
          nextLlmApiKeys[llmProvider] = apiKey;
        }
        for (const [providerId, key] of otherKeys) {
          nextLlmApiKeys[providerId] = key;
        }
        const nextSecrets: Secrets = {
          ...loaded.secrets,
          llm_api_keys: nextLlmApiKeys,
        };
        await writeSecrets(loaded.dir, nextSecrets, passphrase);
        loaded.secrets = nextSecrets;
      }
      console.log('  LLM updated.\n');
    }
  }

  console.log(`  Agent "${name}" saved.\n`);
}

function truncate(value: string, max = 40): string {
  if (value.length <= max) {
    return value;
  }
  return value.slice(0, max - 1) + '…';
}

/** Status hint shown next to the API-key prompt so the user knows what's stored. */
function describeKeyStatus(secrets: Secrets, providerId: string): string {
  return secrets.llm_api_keys?.[providerId] ? 'set' : 'not set';
}

/** Pick the stored key for model probing. `loaded.secrets` is post-decrypt, so values are plaintext. */
function pickPlainKey(secrets: Secrets, providerId: string): string {
  const value = secrets.llm_api_keys?.[providerId];
  return typeof value === 'string' ? value : '';
}
