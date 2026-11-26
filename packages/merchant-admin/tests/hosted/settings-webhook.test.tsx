import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsTab } from '../../src/hosted/components/SettingsTab';
import {
  SUSPEND_EXPLAINED,
  SUSPEND_TEXTS,
  TYPE_TO_CONFIRM,
  WINDING_DOWN,
} from '../../src/hosted/components/SuspendStore';
import {
  NO_WEBHOOK,
  ROTATE_AT_ONCE,
  SECRET_MISSING,
  SECRET_ONCE,
} from '../../src/hosted/components/WebhookSecret';
import { ApiError } from '../../src/hosted/lib/api';
import { NIP05_NOT_USABLE, OWNER_NAME, nip05Usable } from '../../src/hosted/lib/nip05';
import type { StoreApi } from '../../src/hosted/lib/store-session';
import type { ConfigInput, Payout, StoreView } from '../../src/hosted/lib/types';
import {
  MAX_WEBHOOK_URL,
  WEBHOOK_NOT_USABLE,
  webhookUrlInput,
} from '../../src/hosted/lib/webhook-url';
import { type Mounted, buttonNamed, click, inputById, mount, settle } from '../mount';
import { storeView } from './fakes';
import {
  LEAK,
  NOW,
  RELAYS,
  SOLANA_ADDRESS,
  SOLANA_USDC,
  fakeSession,
  storeConfig,
} from './store-fakes';

const PAYOUTS: Payout[] = [{ caip19: SOLANA_USDC, address: SOLANA_ADDRESS, signature: 'sig' }];
const HOOK = 'https://shop.example.com/hook';
const SECRET = 'a1'.repeat(32);

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function view(overrides: Partial<StoreView> = {}, webhookUrl: string | null = HOOK): StoreView {
  return storeView({
    status: 'active',
    config: storeConfig({
      draftPayouts: PAYOUTS,
      inboxRelays: RELAYS,
      revision: 3,
      ...(webhookUrl === null ? {} : { webhookUrl }),
    }),
    webhookSecretSet: true,
    ...overrides,
  });
}

async function open(current: StoreView, overrides: Partial<StoreApi> = {}) {
  const onChanged = vi.fn();
  const fake = fakeSession(overrides);
  mounted = await mount(
    <SettingsTab session={fake.session} view={current} onChanged={onChanged} />,
  );
  return { ...fake, container: mounted.container, onChanged };
}

describe('the webhook URL', () => {
  it('reads a typed URL as the server would: empty is none', () => {
    expect(webhookUrlInput('  ')).toBeNull();
    expect(webhookUrlInput(` ${HOOK} `)).toBe(HOOK);
    expect(webhookUrlInput('https://shop.example.com:443/hook')).toBe(
      'https://shop.example.com:443/hook',
    );
    const longest = `https://shop.example.com/${'a'.repeat(MAX_WEBHOOK_URL - 25)}`;
    expect(longest).toHaveLength(MAX_WEBHOOK_URL);
    expect(webhookUrlInput(longest)).toBe(longest);
  });

  it.each([
    'http://shop.example.com/hook',
    'javascript:alert(1)',
    'shop.example.com',
    'https://shop.example.com:8443/hook',
    'https://user:pass@shop.example.com/hook',
    'https://user@shop.example.com/hook',
    'https://:pass@shop.example.com/hook',
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://10.0.0.1/hook',
    'https://localhost/hook',
    'https://shop.local/hook',
    'https://shop/hook',
    `https://shop.example.com/${'a'.repeat(MAX_WEBHOOK_URL - 24)}`,
  ])('refuses %s, as the server does', (typed) => {
    expect(webhookUrlInput(typed)).toBeUndefined();
  });

  it('says a bad_config refusal generically, whatever changed', async () => {
    const { container } = await open(view(), {
      putConfig: async () => {
        throw new ApiError(400, 'bad_config', { problems: [LEAK] });
      },
    });
    await type(inputById(container, 'settings-webhook'), 'https://other.example.com/h');
    await click(buttonNamed(container, 'Save settings'));
    await settle(() => text(container).includes('Some settings are not valid'));
    expect(text(container)).not.toContain('SECRET');
  });

  it('saves a new URL, or none, in the whole config at the revision read', async () => {
    const puts: ConfigInput[] = [];
    const { container, onChanged } = await open(view(), {
      putConfig: async (input) => {
        puts.push(input);
        return { config: storeConfig({ revision: 4 }), requestId: null };
      },
    });
    expect(inputById(container, 'settings-webhook').value).toBe(HOOK);
    await type(inputById(container, 'settings-webhook'), ' https://new.example.com/h ');
    await click(buttonNamed(container, 'Save settings'));
    await settle(() => text(container).includes('Settings saved.'));
    await type(inputById(container, 'settings-webhook'), '');
    await click(buttonNamed(container, 'Save settings'));
    await settle(() => puts.length === 2);
    expect(puts.map((input) => input.webhookUrl)).toEqual(['https://new.example.com/h', null]);
    expect(puts[0]).toMatchObject({ payouts: PAYOUTS, inboxRelays: RELAYS, expectedRevision: 3 });
    expect(onChanged).toHaveBeenCalled();
  });

  it('refuses a URL that is not https before asking the server', async () => {
    const putConfig = vi.fn();
    const { container } = await open(view(), { putConfig });
    await type(inputById(container, 'settings-webhook'), 'http://shop.example.com/hook');
    await click(buttonNamed(container, 'Save settings'));
    expect(text(container)).toContain(WEBHOOK_NOT_USABLE);
    expect(putConfig).not.toHaveBeenCalled();
  });
});

describe('the webhook secret', () => {
  it('prompts to generate a secret for a URL saved without one, and shows it once', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const { container, onChanged } = await open(view({ webhookSecretSet: false }), {
      rotateWebhookSecret: async () => ({ secret: SECRET, requestId: 'r1' }),
    });
    expect(text(container)).toContain(SECRET_MISSING);
    await click(buttonNamed(container, 'Generate a secret'));
    await settle(() => container.querySelector('#webhook-secret') !== null);
    expect(container.querySelector('#webhook-secret')?.textContent).toBe(SECRET);
    expect(text(container)).toContain(SECRET_ONCE);
    expect(container.querySelector('[aria-label="Copy the webhook secret"]')).not.toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(storage).not.toHaveBeenCalled();
    await click(buttonNamed(container, 'I copied it'));
    expect(text(container)).not.toContain(SECRET);
  });

  it('says to save a URL first when there is none', async () => {
    const { container } = await open(view({ webhookSecretSet: false }, null));
    expect(text(container)).toContain(NO_WEBHOOK);
    expect(text(container)).not.toContain(SECRET_MISSING);
  });

  it('rotates a set secret only after saying it changes at once', async () => {
    const rotate = vi.fn(async () => ({ secret: SECRET, requestId: null }));
    const { container } = await open(view(), { rotateWebhookSecret: rotate });
    expect(text(container)).toContain(ROTATE_AT_ONCE);
    expect(text(container)).not.toContain(SECRET_MISSING);
    await click(buttonNamed(container, 'Rotate secret'));
    expect(rotate).not.toHaveBeenCalled();
    await click(buttonNamed(container, 'Cancel'));
    expect(container.querySelector('#webhook-secret')).toBeNull();
    await click(buttonNamed(container, 'Rotate secret'));
    await click(buttonNamed(container, 'Rotate now'));
    await settle(() => container.querySelector('#webhook-secret') !== null);
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it('says a refusal in a fixed sentence and shows no secret', async () => {
    const { container } = await open(view(), {
      rotateWebhookSecret: async () => {
        throw new ApiError(409, 'suspended', { message: LEAK });
      },
    });
    await click(buttonNamed(container, 'Rotate secret'));
    await click(buttonNamed(container, 'Rotate now'));
    await settle(() => text(container).includes('Your store is suspended'));
    expect(text(container)).not.toContain('SECRET');
    expect(container.querySelector('#webhook-secret')).toBeNull();
    expect(buttonNamed(container, 'Rotate secret').disabled).toBe(false);
  });
});

describe('suspending the store', () => {
  it('is hidden while the store is pending', async () => {
    const { container } = await open(view({ status: 'pending' }));
    expect(text(container)).not.toContain('Suspend store');
  });

  it('says the store is winding down once suspending or suspended', async () => {
    for (const status of ['suspending', 'suspended'] as const) {
      const { container } = await open(view({ status }));
      expect(text(container)).toContain(WINDING_DOWN);
      expect(container.querySelector('#suspend-confirm')).toBeNull();
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('suspends only once the word is typed, and follows the request until applied', async () => {
    const suspend = vi.fn(async () => ({ request: { id: 'r9', state: 'pending' as const } }));
    let reads = 0;
    const { container, onChanged, sleeps } = await open(view({ status: 'degraded' }), {
      suspend,
      request: async (id) => {
        reads += 1;
        return {
          request: {
            id,
            kind: 'suspend',
            state: reads < 3 ? 'pending' : 'applied',
            result: null,
            createdAt: NOW,
            appliedAt: null,
          },
        };
      },
    });
    expect(text(container)).toContain(SUSPEND_EXPLAINED);
    await click(buttonNamed(container, 'Suspend store'));
    expect(text(container)).toContain(TYPE_TO_CONFIRM);
    await type(inputById(container, 'suspend-confirm'), 'suspen');
    await click(buttonNamed(container, 'Suspend store'));
    expect(suspend).not.toHaveBeenCalled();
    await type(inputById(container, 'suspend-confirm'), ' Suspend ');
    await click(buttonNamed(container, 'Suspend store'));
    await settle(() => text(container).includes(SUSPEND_TEXTS.done));
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([2000, 2000, 2000]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('says a still-applying suspension, and Refresh reads it again', async () => {
    let state: 'pending' | 'applied' = 'pending';
    const { container } = await open(view(), {
      suspend: async () => ({ request: { id: 'r9', state: 'pending' } }),
      request: async (id) => ({
        request: { id, kind: 'suspend', state, result: null, createdAt: NOW, appliedAt: null },
      }),
    });
    await type(inputById(container, 'suspend-confirm'), 'suspend');
    await click(buttonNamed(container, 'Suspend store'));
    await settle(() => text(container).includes(SUSPEND_TEXTS.still));
    state = 'applied';
    await click(buttonNamed(container, 'Refresh'));
    await settle(() => text(container).includes(SUSPEND_TEXTS.done));
  });

  it('says a refusal or a failure by code, never the server text', async () => {
    let refusals = 0;
    const { container } = await open(view(), {
      suspend: async () => {
        refusals += 1;
        throw new ApiError(409, 'inactive', { message: LEAK });
      },
    });
    await type(inputById(container, 'suspend-confirm'), 'suspend');
    await click(buttonNamed(container, 'Suspend store'));
    await settle(() => text(container).includes('Your store is not active'));
    expect(text(container)).not.toContain('SECRET');
    expect(buttonNamed(container, 'Suspend store').disabled).toBe(false);
    await click(buttonNamed(container, 'Suspend store'));
    await vi.waitFor(() => expect(refusals).toBe(2));

    await mounted?.unmount();
    mounted = undefined;
    const failed = await open(view(), {
      suspend: async () => ({
        request: {
          id: 'r9',
          kind: 'suspend',
          state: 'failed',
          result: { code: 'failed', problem: LEAK },
          createdAt: NOW,
          appliedAt: NOW,
        },
      }),
    });
    await type(inputById(failed.container, 'suspend-confirm'), 'suspend');
    await click(buttonNamed(failed.container, 'Suspend store'));
    await settle(() => text(failed.container).includes('The change could not be applied'));
    expect(text(failed.container)).not.toContain('SECRET');
  });

  it('sends one suspension for a double click', async () => {
    const suspend = vi.fn(async () => ({
      request: {
        id: 'r9',
        kind: 'suspend',
        state: 'applied' as const,
        result: null,
        createdAt: NOW,
        appliedAt: NOW,
      },
    }));
    const { container } = await open(view(), { suspend });
    await type(inputById(container, 'suspend-confirm'), 'suspend');
    const button = buttonNamed(container, 'Suspend store');
    await act(async () => {
      button.click();
      button.click();
    });
    await settle(() => text(container).includes(SUSPEND_TEXTS.done));
    expect(suspend).toHaveBeenCalledTimes(1);
  });
});

describe('the store address (nip05)', () => {
  it.each(['shop@example.com', 'example.com', ' Shop@Example.com '])('takes %j', (typed) => {
    expect(nip05Usable(typed.trim())).toBe(true);
  });

  it.each([
    'owner@example.com',
    'OWNER@example.com',
    'shop@localhost',
    'shop@127.0.0.1',
    'shop@@example.com',
    'not an address',
    `${'a'.repeat(1100)}@example.com`,
    `shop@${'a'.repeat(250)}.com`,
  ])('refuses %j, as the server does', (typed) => {
    expect(nip05Usable(typed)).toBe(false);
  });

  it('is the server rule: its bound and the reserved owner name, read from its source', () => {
    // Tests run from the package root (vitest's root).
    const stores = readFileSync(
      join(process.cwd(), '..', 'paycore-server', 'src', 'state', 'stores.ts'),
      'utf8',
    );
    const schema = /export const CreateStoreInputSchema = z([\s\S]*?)\.strict\(\);/.exec(
      stores,
    )?.[1];
    expect(schema).toContain('splitNip05(value) !== undefined');
    expect(schema).toContain(`splitNip05(value)?.local !== '${OWNER_NAME}'`);
    const node = readFileSync(
      join(process.cwd(), '..', 'merchant-node', 'src', 'config.ts'),
      'utf8',
    );
    expect(node).toContain(`splitNip05(value)?.local !== '${OWNER_NAME}'`);
  });

  it('saves a blank-looking address as no address', async () => {
    const puts: ConfigInput[] = [];
    const { container } = await open(view(), {
      putConfig: async (input) => {
        puts.push(input);
        return { config: storeConfig({ revision: 4 }), requestId: null };
      },
    });
    await type(inputById(container, 'settings-nip05'), '   ');
    await click(buttonNamed(container, 'Save settings'));
    await settle(() => puts.length === 1);
    expect(text(container)).not.toContain(NIP05_NOT_USABLE);
    expect(puts[0]?.nip05).toBeUndefined();
  });

  it('refuses an address the server would not take before saving', async () => {
    const putConfig = vi.fn();
    const { container } = await open(view(), { putConfig });
    await type(inputById(container, 'settings-nip05'), 'owner@example.com');
    await click(buttonNamed(container, 'Save settings'));
    expect(text(container)).toContain(NIP05_NOT_USABLE);
    expect(putConfig).not.toHaveBeenCalled();
  });
});
