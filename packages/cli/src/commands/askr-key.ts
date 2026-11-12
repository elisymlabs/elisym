/**
 * `elisym askr-key <agent> --store <owner npub>` - give the agent an Askr
 * catalog key K for one store (7.2): generated here, kept encrypted with the
 * agent's other secrets, with the store owner's pubkey in elisym.yaml. Only
 * K's pubkey is printed; the store owner authorizes it in the Askr admin, and
 * from then on the agent's MCP tools write that store's products and
 * policies. No secret is ever printed or taken as an argument.
 */
import { loadAgent, writeSecrets, writeYaml } from '@elisym/sdk/agent-store';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

export interface AskrKeyOptions {
  /** The store owner's npub (or hex pubkey). Required to create a key. */
  store?: string;
  /** Print the existing key and store only; never generate. */
  show?: boolean;
  /** Replace the key (and the store, if another is named). */
  rotate?: boolean;
}

export interface AskrKeyResult {
  status: 'created' | 'rotated' | 'existing';
  pubkey: string;
  store: string;
}

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

/** The owner pubkey (hex) from an npub or a hex key; throws on anything else. */
export function parseStoreOwner(value: string): string {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  if (HEX_PUBKEY_RE.test(lowered)) {
    return lowered;
  }
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'npub') {
      return decoded.data;
    }
  } catch {
    // Reported below with what is expected instead.
  }
  throw new Error('--store must be the store owner npub (npub1...) or a 64-character hex pubkey');
}

/**
 * Create, show or rotate the agent's Askr catalog key. A key is never
 * replaced silently: another store, or a new key, needs `rotate`.
 */
export async function runAskrKey(
  agentName: string,
  cwd: string,
  passphrase: string | undefined,
  options: AskrKeyOptions,
): Promise<AskrKeyResult> {
  const loaded = await loadAgent(agentName, cwd, passphrase);
  const existing = loaded.secrets.askr_catalog_secret_key;
  const currentStore = loaded.yaml.askr_store;
  const store = options.store === undefined ? undefined : parseStoreOwner(options.store);

  if (options.show) {
    if (existing === undefined || currentStore === undefined) {
      throw new Error(
        `Agent "${agentName}" has no Askr catalog key. Run \`elisym askr-key ${agentName} --store <owner npub>\` to create one.`,
      );
    }
    return {
      status: 'existing',
      pubkey: getPublicKey(hexToBytes(existing)),
      store: currentStore,
    };
  }

  if (existing !== undefined && currentStore === undefined && !options.rotate) {
    // A key whose store went missing (a hand edit, or a run stopped between its two writes)
    // is re-attached, never silently replaced.
    if (store === undefined) {
      throw new Error(
        `Agent "${agentName}" has an Askr catalog key but no store. Pass --store <owner npub> to attach it, or --rotate for a new key.`,
      );
    }
    await writeYaml(loaded.dir, { ...loaded.yaml, askr_store: store });
    return { status: 'existing', pubkey: getPublicKey(hexToBytes(existing)), store };
  }

  if (existing !== undefined && currentStore !== undefined && !options.rotate) {
    if (store !== undefined && store !== currentStore) {
      throw new Error(
        `Agent "${agentName}" already writes another store's catalog. Use --rotate to replace its key and store.`,
      );
    }
    return {
      status: 'existing',
      pubkey: getPublicKey(hexToBytes(existing)),
      store: currentStore,
    };
  }

  const target = store ?? currentStore;
  if (target === undefined) {
    throw new Error('--store <owner npub> is required: the store whose catalog this key writes');
  }
  const secret = bytesToHex(generateSecretKey());
  // The key goes first. A run stopped between the two writes leaves the new key on the old
  // store, which never authorized it; a rotation away from a leaked key never ends with that
  // key shown as the new store's.
  await writeSecrets(
    loaded.dir,
    { ...loaded.secrets, askr_catalog_secret_key: secret },
    passphrase,
  );
  await writeYaml(loaded.dir, { ...loaded.yaml, askr_store: target });
  return {
    status: existing === undefined ? 'created' : 'rotated',
    pubkey: getPublicKey(hexToBytes(secret)),
    store: target,
  };
}

export async function cmdAskrKey(agentName: string, options: AskrKeyOptions): Promise<void> {
  const passphrase = process.env.ELISYM_PASSPHRASE;
  let result: AskrKeyResult;
  try {
    result = await runAskrKey(agentName, process.cwd(), passphrase, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (result.status === 'existing' && !options.show) {
    console.log(`  Agent "${agentName}" already has an Askr catalog key.`);
  } else if (result.status !== 'existing') {
    console.log(
      result.status === 'created'
        ? '\n  Askr catalog key generated and saved.'
        : '\n  Askr catalog key rotated and saved. Revoke the old key in the Askr admin.',
    );
  }
  console.log(`  Store:       ${nip19.npubEncode(result.store)}`);
  console.log(`  Catalog key: ${nip19.npubEncode(result.pubkey)}`);
  console.log(`               ${result.pubkey}`);
  if (result.status !== 'existing') {
    console.log(
      '\n  Authorize this catalog key in the Askr admin (Catalog keys), signed by the store owner.\n' +
        '  Until then the store refuses what it signs.\n',
    );
  }
  if (!passphrase && result.status !== 'existing') {
    console.warn('  ! No passphrase set: the catalog key is stored unencrypted on disk.');
  }
}
