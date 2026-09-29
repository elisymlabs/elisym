/**
 * `buy_product` and `get_order` end to end on devnet, through the tools
 * themselves, against a running test store (packages/merchant-node):
 *
 *   bun scripts/e2e-buy-devnet.ts <agent name> <naddr>
 *
 * The agent (an elisym agent with a funded devnet wallet) pays for real on
 * devnet. Mainnet is refused here on purpose.
 */
import { loadAgent } from '@elisym/sdk/agent-store';
import { getBase58Encoder } from '@solana/kit';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { defaultSpendLimitsMap } from '../src/session-limits.js';
import { commerceTools } from '../src/tools/commerce.js';

const [, , agentName, naddr] = process.argv;
if (agentName === undefined || naddr === undefined || !naddr.startsWith('naddr1')) {
  throw new Error('usage: bun scripts/e2e-buy-devnet.ts <agent name> <naddr>');
}
const loaded = await loadAgent(agentName, process.cwd());
const secret = loaded.secrets.solana_secret_key;
if (secret === undefined) {
  throw new Error(`agent ${agentName} has no Solana wallet`);
}
const agent = {
  client: {} as never,
  identity: {} as never,
  name: agentName,
  network: 'devnet',
  security: {},
  agentDir: loaded.dir,
  solanaKeypair: { publicKey: '', secretKey: new Uint8Array(getBase58Encoder().encode(secret)) },
} as AgentInstance;
const ctx = new AgentContext();
ctx.sessionSpendLimits = defaultSpendLimitsMap();
ctx.register(agent);

function tool(name: string) {
  const found = commerceTools.find((each) => each.name === name);
  if (found === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return found;
}

function log(label: string, result: { content: { text: string }[]; isError?: boolean }): string {
  const body = result.content.map((part) => part.text).join('\n');
  console.log(`--- ${label}${result.isError === true ? ' (error)' : ''}\n${body}\n`);
  return body;
}

const quote = log('quote', (await tool('buy_product').handler(ctx, { product: naddr })) as never);
const quoteId = /quote_id: ([0-9a-f-]{36})/.exec(quote)?.[1];
if (quoteId === undefined) {
  throw new Error('no quote');
}
const warnings = [...quote.matchAll(/confirmation \(([a-z_]+)\)/g)].map((match) => match[1]);
const bought = log(
  'buy',
  (await tool('buy_product').handler(ctx, {
    quote_id: quoteId,
    accept_warnings: warnings,
  })) as never,
);
const orderId = /order ([0-9a-f-]{36})/i.exec(bought)?.[1];
if (orderId === undefined) {
  process.exit(bought.includes('Delivered') ? 0 : 1);
}
for (let round = 0; round < 6 && !bought.includes('Delivered'); round += 1) {
  const followed = log(
    `get_order ${round + 1}`,
    (await tool('get_order').handler(ctx, { order_id: orderId })) as never,
  );
  if (followed.includes('Delivered')) {
    process.exit(0);
  }
}
process.exit(bought.includes('Delivered') ? 0 : 1);
