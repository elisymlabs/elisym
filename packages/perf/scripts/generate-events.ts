#!/usr/bin/env bun
/**
 * Pre-sign a fixture of NIP-01 events for k6 ws scenarios.
 *
 * Why: k6 cannot sign schnorr/secp256k1 events natively. Pre-generating events
 * with nostr-tools also keeps k6 measuring relay throughput rather than crypto
 * cost on the load-generator side.
 *
 * Output: packages/perf/k6/fixtures/events-<kind>.json
 *
 * Usage:
 *   bun packages/perf/scripts/generate-events.ts --kind 5100 --count 5000
 *   bun packages/perf/scripts/generate-events.ts --kind 31990 --count 1000 --capability translate
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

interface Args {
  kind: number;
  count: number;
  capability: string;
  out: string;
  seedKeys: number;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--kind':
        args.kind = Number.parseInt(value ?? '', 10);
        i++;
        break;
      case '--count':
        args.count = Number.parseInt(value ?? '', 10);
        i++;
        break;
      case '--capability':
        args.capability = value ?? 'translate';
        i++;
        break;
      case '--out':
        args.out = value ?? '';
        i++;
        break;
      case '--seed-keys':
        args.seedKeys = Number.parseInt(value ?? '', 10);
        i++;
        break;
    }
  }
  if (!args.kind || !args.count) {
    throw new Error('--kind and --count are required');
  }
  return {
    kind: args.kind,
    count: args.count,
    capability: args.capability ?? 'translate',
    out: args.out ?? `packages/perf/k6/fixtures/events-${args.kind}.json`,
    seedKeys: args.seedKeys ?? Math.min(args.count, 256),
  };
}

function buildContent(kind: number, capability: string, idx: number): string {
  // kind 5100 (job request): plaintext input, broadcast variant.
  if (kind >= 5000 && kind < 6000) {
    return `perf-fixture job ${idx}: please ${capability} the following text`;
  }
  // kind 31990 (NIP-89 capability): handler info JSON.
  if (kind === 31990) {
    return JSON.stringify({
      name: `perf-agent-${idx}`,
      about: `synthetic perf-test agent ${idx}`,
      picture: '',
    });
  }
  return `perf-fixture event ${idx}`;
}

function buildTags(
  kind: number,
  capability: string,
  idx: number,
  providerPubkey: string,
): string[][] {
  // job request (NIP-90 family, elisym uses kind 5100)
  if (kind >= 5000 && kind < 6000) {
    return [
      ['i', `perf input ${idx}`, 'text'],
      ['t', capability],
      ['t', 'elisym'],
    ];
  }
  // NIP-89 capability announcement (kind 31990, parameterized replaceable)
  if (kind === 31990) {
    return [
      ['d', `${capability}:${providerPubkey.slice(0, 8)}`],
      ['k', '5100'],
      ['t', capability],
      ['t', 'elisym'],
    ];
  }
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Pool of synthetic keypairs to spread events across multiple authors,
  // so the relay sees realistic fanout instead of a single hot author.
  const keys = Array.from({ length: args.seedKeys }, () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    return { sk, pk };
  });

  const events: object[] = [];
  for (let i = 0; i < args.count; i++) {
    const key = keys[i % keys.length];
    const event = finalizeEvent(
      {
        kind: args.kind,
        created_at: Math.floor(Date.now() / 1000) - (args.count - i),
        tags: buildTags(args.kind, args.capability, i, key.pk),
        content: buildContent(args.kind, args.capability, i),
      },
      key.sk,
    );
    events.push(event);
  }

  const outPath = resolve(process.cwd(), args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(events));

  process.stdout.write(
    `wrote ${events.length} kind=${args.kind} events from ${keys.length} keypairs to ${args.out}\n`,
  );
}

await main();
