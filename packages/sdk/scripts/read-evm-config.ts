#!/usr/bin/env bun
/**
 * Read the elisym protocol config off an EVM chain, the way every client does.
 *
 * A MANUAL tool, not a CI test: it needs a live endpoint. It exists because the
 * phase-2a exit gate asks for "the config readable from Moderato by a script",
 * and four review rounds each rebuilt an ad-hoc probe to answer it. It reads
 * and prints; it signs nothing and sends nothing.
 *
 *   CHAIN=devnet|mainnet \
 *   RPC_URL=<optional override> \
 *   bun packages/sdk/scripts/read-evm-config.ts
 *
 * What it shows, in order: the fresh read, the same read served from cache with
 * its age, a forced re-read, and the two refusals a misconfigured endpoint
 * produces - the wrong chain, and an address with no contract at it. The last
 * one is worth recognising: an `eth_call` at `finalized` against a backend whose
 * finalized head predates the deployment block answers `0x`, which is exactly
 * what "no code there" looks like, so a lagging endpoint makes the config
 * refuse where a plain transport failure would have been served from cache.
 */

import {
  clearEvmProtocolConfigCache,
  createJsonRpcClient,
  getEvmProtocolConfig,
  WrongEvmChainError,
} from '@elisym/pay-core';
import { CHAINS, type ChainConfig } from '@elisym/pay-core';

const chain: ChainConfig =
  process.env.CHAIN === 'mainnet' ? CHAINS.TEMPO_MAINNET : CHAINS.TEMPO_DEVNET;
const endpoint = process.env.RPC_URL ?? chain.rpcUrls[0];

if (endpoint === undefined) {
  throw new Error(`No endpoint for ${chain.caip2}; set RPC_URL.`);
}
if (chain.protocolConfig === undefined) {
  throw new Error(
    `${chain.caip2} carries no config contract in the registry yet, so nothing can be priced ` +
      `there. That is the state Tempo mainnet is in until phase 6 deploys one.`,
  );
}

const client = createJsonRpcClient(endpoint);
console.log(`chain    ${chain.caip2} (${chain.network})`);
console.log(`endpoint ${endpoint}`);
console.log(`contract ${chain.protocolConfig.address}\n`);

const fresh = await getEvmProtocolConfig(client, chain);
console.log('fresh  ', JSON.stringify(fresh));
const cached = await getEvmProtocolConfig(client, chain);
console.log('cached ', JSON.stringify(cached));
const forced = await getEvmProtocolConfig(client, chain, { forceRefresh: true });
console.log('forced ', JSON.stringify(forced));

clearEvmProtocolConfigCache();
// The OTHER Tempo network, with this one's config contract attached: mainnet
// carries none yet, so asking about it directly would refuse for the wrong
// reason and print nothing about the chain id at all.
const otherChain = {
  ...(chain.network === 'mainnet' ? CHAINS.TEMPO_DEVNET : CHAINS.TEMPO_MAINNET),
  protocolConfig: chain.protocolConfig,
};
const wrong = await getEvmProtocolConfig(client, otherChain).catch((error: unknown) => error);
console.log(
  '\nwrong chain ->',
  wrong instanceof WrongEvmChainError ? `refused: ${wrong.message}` : `NOT REFUSED: ${wrong}`,
);

clearEvmProtocolConfigCache();
const noContract = { ...chain, protocolConfig: { address: `0x${'ab'.repeat(20)}` } };
const missing = await getEvmProtocolConfig(client, noContract).catch((error: unknown) => error);
console.log(
  'no contract ->',
  missing instanceof Error
    ? `refused: ${missing.message}`
    : `NOT REFUSED: ${JSON.stringify(missing)}`,
);
