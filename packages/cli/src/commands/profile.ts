import {
  listAgents,
  loadAgent,
  writeSecrets,
  writeYaml,
  type ElisymYaml,
  type LlmEntry,
} from '@elisym/sdk/agent-store';
/**
 * Profile command - edit agent profile, wallet, and LLM settings.
 * Writes back to elisym.yaml (public) and .secrets.json (private).
 */
import { isEncrypted } from '@elisym/sdk/node';
import { isAddress } from '@solana/kit';

export async function cmdProfile(name: string | undefined): Promise<void> {
  const { default: inquirer } = await import('inquirer');
  const cwd = process.cwd();

  if (!name) {
    const agents = await listAgents(cwd);
    if (agents.length === 0) {
      console.error('No agents found. Run `elisym init` first.');
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
      const current = loaded.yaml.payments[0];
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'address',
          message: 'Solana address (empty to clear):',
          default: current?.address ?? '',
          validate: (value: string) => {
            if (!value) {
              return true;
            }
            return isAddress(value) || 'Invalid Solana address';
          },
        },
      ]);

      const nextYaml: ElisymYaml = {
        ...loaded.yaml,
        payments: answers.address
          ? [{ chain: 'solana', network: 'devnet', address: answers.address }]
          : [],
      };
      await writeYaml(loaded.dir, nextYaml);
      loaded.yaml = nextYaml;
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
          default: loaded.yaml.llm?.provider ?? 'anthropic',
        },
      ]);

      const { apiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: 'API key (leave empty to keep current):',
          mask: '*',
        },
      ]);

      const currentKeyPlain =
        loaded.secrets.llm_api_key && !isEncrypted(loaded.secrets.llm_api_key)
          ? loaded.secrets.llm_api_key
          : '';
      const probeKey = apiKey || currentKeyPlain;

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

      const nextLlm: LlmEntry = { provider: llmProvider, model, max_tokens: maxTokens };
      const nextYaml: ElisymYaml = { ...loaded.yaml, llm: nextLlm };
      await writeYaml(loaded.dir, nextYaml);
      loaded.yaml = nextYaml;

      if (apiKey) {
        await writeSecrets(loaded.dir, { ...loaded.secrets, llm_api_key: apiKey }, passphrase);
        loaded.secrets = { ...loaded.secrets, llm_api_key: apiKey };
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
