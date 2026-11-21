/**
 * The `askr` command group's names, flags and descriptions, registered
 * statically so `--help` works without loading `@elisym/askr`. Each action
 * hands its invocation to the runner, which loads the rest on demand.
 */
import type { Command } from 'commander';
import type { InitOptions } from './init';
import type { PolicyOptions } from './policy';
import type { ProductsOptions } from './products';
import type { AskrInvocation, InvocationContext } from './runner';
import type { StatusOptions } from './status';

export type AskrRun = (invocation: AskrInvocation, context: InvocationContext) => Promise<void>;

interface ProfileOption {
  profile?: string;
}

const PROFILE_FLAG = '--profile <name>';
const PROFILE_HELP = 'a separate store on this computer: its own owner key file (default: default)';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Register `askr` on `program`. With `jsonErrors` (the line starts with
 * `askr`), parse errors throw instead of printing, so the caller prints the
 * one JSON object; help still goes to stdout.
 */
export function registerAskr(
  program: Command,
  run: AskrRun,
  args: readonly string[],
  jsonErrors: boolean,
): Command {
  const askr = program
    .command('askr')
    .description(
      'Set up and update an Askr store from a terminal or an AI coding agent: JSON output, no prompts',
    );
  if (jsonErrors) {
    // Set before the subcommands are added: they copy these settings when created.
    askr.exitOverride().configureOutput({ writeErr: () => {} });
  }
  const context = (options: ProfileOption): InvocationContext => ({
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    args,
  });

  askr
    .command('init')
    .description('Create the store (or update it) and sign its settings; never chooses a plan')
    .option('--name <text>', 'store name (required for a new store)')
    .option('--origin <https-origin>', 'a site the chat runs on; repeat for each', collect, [])
    .option('--language <bcp47>', 'catalog language (default en for a new store)')
    .option('--currency <iso4217>', 'store currency (default USD for a new store)')
    .option('--source <source>', 'where products come from: admin (files) or connector')
    .option('--platform <platform>', 'connector platform: shopify, woocommerce or google')
    .option('--shop-url <url>', 'Shopify or WooCommerce: the https address of the shop')
    .option('--feed-url <url>', 'google: the https address of the product feed')
    .option('--display-name <text>', "the assistant's name in the chat")
    .option('--greeting <text>', 'the first message the chat shows')
    .option('--contact <https-url>', 'a contact link the assistant may give')
    .option('--voice-file <path>', "a text file with the assistant's voice")
    .option(
      '--instructions-file <path>',
      'a text file with what the assistant always or never says',
    )
    .option('--owner-key-file <path>', 'adopt a store made in the admin: its secret key file')
    .option('--update', 'allow changing the name or origins of the existing store')
    .option(PROFILE_FLAG, PROFILE_HELP)
    .action((options: InitOptions & ProfileOption) =>
      run({ command: 'init', options }, context(options)),
    );

  askr
    .command('plan <plan>')
    .description(
      "Choose a plan: only free is self-serve; run it only on the human's explicit choice",
    )
    .option(PROFILE_FLAG, PROFILE_HELP)
    .action((plan: string, options: ProfileOption) =>
      run({ command: 'plan', plan }, context(options)),
    );

  askr
    .command('products')
    .description('Publish products from a JSON or CSV file (source admin)')
    .requiredOption('--file <path>', 'products.json or products.csv')
    .option(
      '--replace',
      'the file is the whole catalog: listed products missing from it are hidden',
    )
    .option('--allow-hide', 'with --replace: allow hiding products (after the human confirmed)')
    .option('--dry-run', 'print what would change, publish nothing')
    .option(PROFILE_FLAG, PROFILE_HELP)
    .action((options: ProductsOptions & ProfileOption) =>
      run({ command: 'products', options }, context(options)),
    );

  askr
    .command('policy')
    .description('Publish one policy page (returns, shipping, warranty, faq, ...)')
    .requiredOption('--slug <slug>', 'lowercase letters, digits and hyphens, like returns')
    .requiredOption('--title <text>', 'the policy title')
    .requiredOption('--file <path>', 'a Markdown file with the policy text')
    .option(PROFILE_FLAG, PROFILE_HELP)
    .action((options: PolicyOptions & ProfileOption) =>
      run({ command: 'policy', options }, context(options)),
    );

  askr
    .command('connector')
    .description('Preview the shop connector, enable it, and wait for its first sync')
    .option(PROFILE_FLAG, PROFILE_HELP)
    .action((options: ProfileOption) => run({ command: 'connector' }, context(options)));

  askr
    .command('status')
    .description('Show the store: plan, products, policies, connector, usage')
    .option('--probe', 'also check that the chat is served on the first site')
    .option(PROFILE_FLAG, PROFILE_HELP)
    .action((options: StatusOptions & ProfileOption) =>
      run({ command: 'status', options }, context(options)),
    );

  askr
    .command('embed')
    .description('Print the widget snippet, the verification meta tag and the CSP sources')
    .option(PROFILE_FLAG, PROFILE_HELP)
    .action((options: ProfileOption) => run({ command: 'embed' }, context(options)));

  askr
    .command('export-key')
    .description(
      'Write the owner key as a key file for your password manager (run it yourself, never by an agent)',
    )
    .requiredOption('--out <path>', 'a new file to write (never overwritten)')
    .option(PROFILE_FLAG, PROFILE_HELP)
    .action((options: { out: string } & ProfileOption) =>
      run({ command: 'export-key', out: options.out }, context(options)),
    );

  return askr;
}
