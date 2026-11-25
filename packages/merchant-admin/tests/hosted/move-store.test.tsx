import { nip19 } from 'nostr-tools';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedApp } from '../../src/hosted/App';
import { DOMAIN_NOW, MOVED_TITLE } from '../../src/hosted/components/MoveDone';
import { NOT_A_KEY } from '../../src/hosted/components/MoveKeyChoice';
import {
  MOVED_DONE,
  MOVED_FOLLOWING,
  MOVED_ON_ACTIVATION,
  MOVE_NO_PAYOUTS,
  MOVE_SWITCHING,
} from '../../src/hosted/components/MoveStore';
import { SWITCHING_TITLE } from '../../src/hosted/components/MoveSwitching';
import {
  WARN_ASKR,
  WARN_DOMAIN,
  WARN_FOREVER,
  WARN_PAYOUT_NOTICE,
  WARN_REPIN,
} from '../../src/hosted/components/MoveWarnings';
import { PAYOUTS_WAIT_FOR_SWITCH } from '../../src/hosted/components/PayoutsTab';
import { SettingsTab } from '../../src/hosted/components/SettingsTab';
import { StoreShell } from '../../src/hosted/components/StoreShell';
import { ApiError } from '../../src/hosted/lib/api';
import { MOVED_KEY, errorMessage } from '../../src/hosted/lib/errors';
import { readHostedConfig } from '../../src/hosted/lib/hosted-config';
import {
  BAD_REVOCATION,
  SAME_KEY,
  STORE_KEY,
  checkMoveTemplates,
  currentPayouts,
  moveOutcome,
  newKeyProblem,
} from '../../src/hosted/lib/move-flow';
import { TEMPLATE_PROBLEMS } from '../../src/hosted/lib/owner-flow';
import { isRemembered, rememberKey } from '../../src/hosted/lib/remembered';
import type { Signer } from '../../src/hosted/lib/signer';
import type { StoreApi } from '../../src/hosted/lib/store-session';
import type {
  MoveInput,
  MovePrepareInput,
  MoveTemplates,
  Payout,
  StoreView,
} from '../../src/hosted/lib/types';
import { proofMessage } from '../../src/hosted/lib/wallets';
import { type Mounted, buttonNamed, click, inputById, mount, settle } from '../mount';
import { CONFIG, OPERATOR, OWNER, OWNER_KEY, STORE_PUBKEY, storeApi, storeView } from './fakes';
import {
  BASE_SEPOLIA_USDC,
  NOW,
  SOLANA_USDC,
  TEST_META,
  authorizationTemplate,
  fakeSession,
  payoutListTemplate,
  storeConfig,
} from './store-fakes';
import { freshDeviceKeys, installStorage } from './stored';
import {
  evmKey,
  fakeSolanaWallet,
  injectStandardWallet,
  personalSign,
  solanaKey,
  utf8Hex,
} from './wallets/fakes';

const META_ON = { ...TEST_META, storeMoves: true };
const EVM = evmKey();
const PAYOUTS: Payout[] = [{ caip19: BASE_SEPOLIA_USDC, address: EVM.lower, signature: 'old-sig' }];

let mounted: Mounted | undefined;
const removers: (() => void)[] = [];
beforeEach(() => {
  installStorage();
  freshDeviceKeys();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  for (const remove of removers.splice(0)) {
    remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

function hasButton(container: HTMLElement, name: string): boolean {
  return [...container.querySelectorAll('button')].some((button) => button.textContent === name);
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function activeView(overrides: Partial<StoreView> = {}, nip05?: string): StoreView {
  return storeView({
    status: 'active',
    config: storeConfig({
      draftPayouts: PAYOUTS,
      revision: 3,
      ...(nip05 === undefined ? {} : { nip05 }),
    }),
    activePayouts: { createdAt: NOW - 100, payouts: PAYOUTS },
    ...overrides,
  });
}

function revocationTemplate(createdAt = NOW): EventTemplate {
  return {
    kind: 30490,
    created_at: createdAt,
    content: '',
    tags: [
      ['d', STORE_PUBKEY],
      ['p', STORE_PUBKEY],
      ['mode', 'revoked'],
    ],
  };
}

/** What a server prepares for `input`: O' list and authorization, O's revocation. */
function prepared(input: MovePrepareInput, withRevocation = true, createdAt = NOW): MoveTemplates {
  return {
    payto: payoutListTemplate(input.payouts, createdAt),
    auth: authorizationTemplate(createdAt),
    revocation: withRevocation ? revocationTemplate(createdAt) : null,
    expiresAt: createdAt + 900,
  };
}

interface MoveServer {
  prepares: MovePrepareInput[];
  moves: { input: MoveInput; newOwner: Signer }[];
  api: Partial<StoreApi>;
}

function moveServer(
  answer: Awaited<ReturnType<StoreApi['move']>> = { request: { id: 'r1', state: 'pending' } },
  withRevocation = true,
  createdAt = NOW,
): MoveServer {
  const server: MoveServer = {
    prepares: [],
    moves: [],
    api: {
      prepareMove: async (input) => {
        server.prepares.push(input);
        return prepared(input, withRevocation, createdAt);
      },
      move: async (input, newOwner) => {
        server.moves.push({ input, newOwner });
        return answer;
      },
    },
  };
  return server;
}

async function openSettings(view: StoreView, api: Partial<StoreApi>, meta = META_ON) {
  const fake = fakeSession(api);
  fake.session.meta = meta;
  mounted = await mount(<SettingsTab session={fake.session} view={view} onChanged={vi.fn()} />);
  return { container: mounted.container, fake };
}

async function chooseNewKey(container: HTMLElement, secretKey: Uint8Array) {
  await click(buttonNamed(container, 'Move to a new owner key'));
  inputById(container, 'move-new-key').value = nip19.nsecEncode(secretKey);
  await click(buttonNamed(container, 'Use this key'));
}

async function signPayoutFor(container: HTMLElement, newOwner: string) {
  const message = proofMessage(newOwner, BASE_SEPOLIA_USDC);
  expect(container.querySelector('#proof-message-0')?.textContent).toBe(message);
  await type(
    inputById(container, 'paste-signature-0'),
    personalSign(EVM.secretKey, utf8Hex(message)),
  );
  await click(buttonNamed(container, 'Check signature'));
  expect(container.querySelector('#move-payout-state-0')?.textContent).toBe(
    'Signed for the new key',
  );
}

async function confirmAndMove(container: HTMLElement) {
  await click(inputById(container, 'move-understood'));
  await click(buttonNamed(container, 'Move store'));
}

describe('the move section', () => {
  it('shows only when the server allows moves, and never on a store winding down', async () => {
    const off = await openSettings(activeView(), {}, { ...TEST_META, storeMoves: false });
    expect(off.container.querySelector('#move-heading')).toBeNull();
    await mounted?.unmount();
    const on = await openSettings(activeView(), {});
    expect(on.container.querySelector('#move-heading')?.textContent).toBe('Move store');
    await mounted?.unmount();
    for (const status of ['suspending', 'suspended'] as const) {
      const winding = await openSettings(activeView({ status }), {});
      expect(winding.container.querySelector('#move-heading')).toBeNull();
      await mounted?.unmount();
    }
    const empty = await openSettings(storeView({ status: 'pending', config: storeConfig() }), {});
    expect(text(empty.container)).toContain(MOVE_NO_PAYOUTS);
    expect(hasButton(empty.container, 'Move to a new owner key')).toBe(false);
  });

  it('while switching, says so and offers no second move', async () => {
    const { container } = await openSettings(activeView({ switching: true }), {});
    expect(text(container)).toContain(MOVE_SWITCHING);
    expect(hasButton(container, 'Move to a new owner key')).toBe(false);
  });

  it('refuses the current owner key, and something that is not a key', async () => {
    const { container } = await openSettings(activeView(), {});
    await chooseNewKey(container, OWNER_KEY);
    expect(text(container)).toContain(SAME_KEY);
    expect(inputById(container, 'move-new-key').value).toBe('');
    inputById(container, 'move-new-key').value = 'nsec1nope';
    await click(buttonNamed(container, 'Use this key'));
    expect(text(container)).toContain(NOT_A_KEY);
    expect(newKeyProblem(STORE_PUBKEY, activeView())).toBe(STORE_KEY);
    expect(newKeyProblem(getPublicKey(generateSecretKey()), activeView())).toBeUndefined();
  });

  it('makes a new key, shown once, and goes on only once it is saved', async () => {
    const { container } = await openSettings(activeView(), {});
    await click(buttonNamed(container, 'Move to a new owner key'));
    await click(buttonNamed(container, 'Create a new owner key'));
    expect(text(container)).toContain('Save your new owner key');
    expect(text(container)).toContain('nsec1');
    expect(buttonNamed(container, 'Continue').disabled).toBe(true);
    const saved = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('I saved my key'))
      ?.querySelector('input');
    if (saved === undefined || saved === null) {
      throw new Error('no saved box');
    }
    await click(saved);
    await click(buttonNamed(container, 'Continue'));
    expect(text(container)).toContain('Sign your payouts for the new key');
  });
});

describe('moving the store', () => {
  it('signs every payout for the new key, warns, then signs with both keys and moves', async () => {
    const newKey = generateSecretKey();
    const newOwner = getPublicKey(newKey);
    await rememberKey(OWNER_KEY);
    expect(isRemembered(OWNER)).toBe(true);
    const server = moveServer();
    const { container, fake } = await openSettings(
      activeView({}, '_@shop.example.com'),
      server.api,
    );
    await chooseNewKey(container, newKey);
    expect(inputById(container, 'move-understood').checked).toBe(false);
    for (const warning of [WARN_REPIN, WARN_PAYOUT_NOTICE, WARN_ASKR, WARN_DOMAIN, WARN_FOREVER]) {
      expect(text(container)).toContain(warning);
    }
    expect(WARN_PAYOUT_NOTICE).toContain('72 hours');
    expect(WARN_DOMAIN).toContain('owner mismatch');

    // Nothing is sent before every payout is signed for O' and the warnings are acknowledged.
    expect(buttonNamed(container, 'Move store').disabled).toBe(true);
    await click(inputById(container, 'move-understood'));
    expect(buttonNamed(container, 'Move store').disabled).toBe(true);
    await click(inputById(container, 'move-understood'));
    await signPayoutFor(container, newOwner);
    // Every payout signed, the warnings not acknowledged: still nothing to press.
    expect(inputById(container, 'move-understood').checked).toBe(false);
    expect(buttonNamed(container, 'Move store').disabled).toBe(true);
    await confirmAndMove(container);
    await settle(() => text(container).includes(MOVED_TITLE));

    expect(server.prepares).toEqual([
      {
        to: newOwner,
        payouts: [{ caip19: BASE_SEPOLIA_USDC, address: EVM.lower, signature: expect.any(String) }],
      },
    ]);
    expect(server.prepares[0]?.payouts[0]?.signature).not.toBe('old-sig');
    const [sent] = server.moves;
    if (sent === undefined) {
      throw new Error('no move');
    }
    expect(sent.newOwner.pubkey).toBe(newOwner);
    expect(sent.input.to).toBe(newOwner);
    const { payto, auth, revocation } = sent.input;
    for (const event of [payto, auth]) {
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(newOwner);
    }
    expect(payto.kind).toBe(10133);
    expect(auth.tags).toEqual(authorizationTemplate().tags);
    if (revocation === undefined) {
      throw new Error('no revocation');
    }
    expect(verifyEvent(revocation)).toBe(true);
    expect(revocation.pubkey).toBe(OWNER);
    expect(revocation.tags).toEqual(revocationTemplate().tags);
    expect(fake.signEvent).toHaveBeenCalledTimes(1);

    // After the move: O is forgotten here, the domain file names O', and the page goes on as O'.
    expect(isRemembered(OWNER)).toBe(false);
    expect(text(container)).toContain(MOVED_FOLLOWING);
    expect(text(container)).toContain(DOMAIN_NOW);
    const json = container.querySelector('#embed-nostr-json')?.textContent ?? '';
    expect(json).toContain(newOwner);
    expect(json).not.toContain(OWNER);
    await click(buttonNamed(container, 'Continue with the new key'));
    await settle(() => vi.mocked(fake.session.switchOwner).mock.calls.length === 1);
    const [move] = vi.mocked(fake.session.switchOwner).mock.calls[0] ?? [];
    expect(move?.signer.pubkey).toBe(newOwner);
    expect(move?.requestId).toBe('r1');
    expect(isRemembered(newOwner)).toBe(true);
  });

  it('leaves the domain out when the store has none, and remembers nothing when the box is cleared', async () => {
    const newKey = generateSecretKey();
    const server = moveServer({
      request: {
        id: 'r2',
        kind: 'setup',
        state: 'applied',
        result: null,
        createdAt: NOW,
        appliedAt: NOW,
      },
    });
    const { container, fake } = await openSettings(activeView(), server.api);
    await chooseNewKey(container, newKey);
    expect(text(container)).not.toContain(WARN_DOMAIN);
    await signPayoutFor(container, getPublicKey(newKey));
    await confirmAndMove(container);
    await settle(() => text(container).includes(MOVED_TITLE));
    expect(text(container)).toContain(MOVED_DONE);
    expect(container.querySelector('#embed-nostr-json')).toBeNull();
    await click(inputById(container, 'move-key-remember'));
    await click(buttonNamed(container, 'Continue with the new key'));
    await settle(() => vi.mocked(fake.session.switchOwner).mock.calls.length === 1);
    expect(vi.mocked(fake.session.switchOwner).mock.calls[0]?.[0].requestId).toBeUndefined();
    expect(isRemembered(getPublicKey(newKey))).toBe(false);
  });

  it('moves a pending store with no revocation: O signs nothing, and it goes live at activation', async () => {
    const newKey = generateSecretKey();
    const server = moveServer({ request: null }, false);
    const pending = storeView({
      status: 'pending',
      config: storeConfig({ draftPayouts: PAYOUTS, revision: 2 }),
    });
    expect(currentPayouts(pending)).toEqual(PAYOUTS);
    const { container, fake } = await openSettings(pending, server.api);
    await chooseNewKey(container, newKey);
    await signPayoutFor(container, getPublicKey(newKey));
    await confirmAndMove(container);
    await settle(() => text(container).includes(MOVED_TITLE));
    expect(server.moves[0]?.input.revocation).toBeUndefined();
    expect('revocation' in (server.moves[0]?.input ?? {})).toBe(false);
    expect(fake.signEvent).not.toHaveBeenCalled();
    expect(text(container)).toContain(MOVED_ON_ACTIVATION);
  });

  it('says each refusal in its fixed sentence and does not switch', async () => {
    for (const [where, code] of [
      ['prepare', 'taken'],
      ['prepare', 'key_in_use'],
      ['prepare', 'payouts_differ'],
      ['prepare', 'no_payouts'],
      ['move', 'busy'],
      ['move', 'switching'],
      ['move', 'moved'],
    ] as const) {
      const newKey = generateSecretKey();
      const server = moveServer();
      const refuse = async () => {
        throw new ApiError(409, code, { message: 'SECRET' });
      };
      const { container, fake } = await openSettings(activeView(), {
        ...server.api,
        ...(where === 'prepare' ? { prepareMove: refuse } : { move: refuse }),
      });
      await chooseNewKey(container, newKey);
      await signPayoutFor(container, getPublicKey(newKey));
      await confirmAndMove(container);
      const sentence = errorMessage(new ApiError(409, code));
      await settle(() => text(container).includes(sentence));
      expect(text(container)).not.toContain('SECRET');
      expect(text(container)).not.toContain(MOVED_TITLE);
      expect(fake.session.switchOwner).not.toHaveBeenCalled();
      expect(buttonNamed(container, 'Move store').disabled).toBe(false);
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('prepares again once when the draft expired or went stale, then moves', async () => {
    for (const code of ['expired', 'stale']) {
      const newKey = generateSecretKey();
      const server = moveServer();
      const tried: MoveInput[] = [];
      const { container } = await openSettings(activeView(), {
        ...server.api,
        // Each prepare dates its templates a second later, as a fresh draft would be.
        prepareMove: async (input) => {
          server.prepares.push(input);
          return prepared(input, true, NOW + server.prepares.length);
        },
        move: async (input, newOwner) => {
          tried.push(input);
          if (tried.length === 1) {
            throw new ApiError(409, code);
          }
          server.moves.push({ input, newOwner });
          return { request: { id: 'r1', state: 'pending' } };
        },
      });
      await chooseNewKey(container, newKey);
      await signPayoutFor(container, getPublicKey(newKey));
      await confirmAndMove(container);
      await settle(() => text(container).includes(MOVED_TITLE));
      expect(server.prepares).toHaveLength(2);
      expect(server.moves).toHaveLength(1);
      // Signed again from the new templates, not the refused events.
      expect(tried[1]?.payto.created_at).toBe(NOW + 2);
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('prepares again only once: a second stale refusal is said, not looped on', async () => {
    const newKey = generateSecretKey();
    const server = moveServer();
    const move = vi.fn(async () => {
      throw new ApiError(409, 'stale');
    });
    const { container, fake } = await openSettings(activeView(), { ...server.api, move });
    await chooseNewKey(container, newKey);
    await signPayoutFor(container, getPublicKey(newKey));
    await confirmAndMove(container);
    await settle(() => text(container).includes(errorMessage(new ApiError(409, 'stale'))));
    expect(server.prepares).toHaveLength(2);
    expect(move).toHaveBeenCalledTimes(2);
    expect(fake.session.switchOwner).not.toHaveBeenCalled();
  });

  it('sends a move whose answer was lost again as it was, and takes alreadyMoved as moved', async () => {
    const newKey = generateSecretKey();
    await rememberKey(OWNER_KEY);
    const server = moveServer();
    const tried: MoveInput[] = [];
    const { container } = await openSettings(activeView(), {
      ...server.api,
      move: async (input) => {
        tried.push(input);
        if (tried.length === 1) {
          throw new TypeError('Failed to fetch');
        }
        return { alreadyMoved: true, requestId: 'r1' };
      },
    });
    await chooseNewKey(container, newKey);
    await signPayoutFor(container, getPublicKey(newKey));
    await confirmAndMove(container);
    await settle(() => text(container).includes(MOVED_TITLE));
    expect(server.prepares).toHaveLength(1);
    expect(tried).toHaveLength(2);
    expect(tried[1]).toEqual(tried[0]);
    expect(text(container)).toContain(MOVED_FOLLOWING);
    expect(isRemembered(OWNER)).toBe(false);
  });

  it('sends a move again when the answer could not be read (a proxy page after the commit)', async () => {
    const newKey = generateSecretKey();
    const server = moveServer();
    const tried: MoveInput[] = [];
    const { container } = await openSettings(activeView(), {
      ...server.api,
      move: async (input) => {
        tried.push(input);
        if (tried.length === 1) {
          throw new ApiError(502, 'unexpected');
        }
        return { alreadyMoved: true, requestId: 'r1' };
      },
    });
    await chooseNewKey(container, newKey);
    await signPayoutFor(container, getPublicKey(newKey));
    await confirmAndMove(container);
    await settle(() => text(container).includes(MOVED_TITLE));
    expect(server.prepares).toHaveLength(1);
    expect(tried).toHaveLength(2);
    expect(tried[1]).toEqual(tried[0]);
    expect(text(container)).toContain(MOVED_FOLLOWING);
  });

  it('drops a held move once the merchant cancels: another key is prepared and sent for itself', async () => {
    const firstKey = generateSecretKey();
    const secondKey = generateSecretKey();
    const server = moveServer();
    const tried: MoveInput[] = [];
    const newOwners: Signer[] = [];
    let online = false;
    const { container } = await openSettings(activeView(), {
      ...server.api,
      move: async (input, newOwner) => {
        tried.push(input);
        newOwners.push(newOwner);
        if (!online) {
          throw new ApiError(0, 'network');
        }
        return { request: { id: 'r1', state: 'pending' } };
      },
    });
    // Every copy of the first key the page makes (MoveStore's and its signer's); the nsec is
    // encoded before the spy, so the test's own copies are not counted.
    const firstNsec = nip19.nsecEncode(firstKey);
    await click(buttonNamed(container, 'Move to a new owner key'));
    inputById(container, 'move-new-key').value = firstNsec;
    const nativeFrom = Uint8Array.from.bind(Uint8Array);
    const made: { copy: Uint8Array; by: string }[] = [];
    const from = vi.spyOn(Uint8Array, 'from').mockImplementation((source: Iterable<unknown>) => {
      const copy = nativeFrom(Array.from(source, Number));
      // The first frame past this spy: the code that asked for the copy.
      const caller = (new Error().stack ?? '')
        .split('\n')
        .slice(1)
        .find((line) => !line.includes('move-store.test') && !line.includes('vitest'));
      made.push({ copy, by: caller ?? '' });
      return copy;
    });
    await click(buttonNamed(container, 'Use this key'));
    // The page's own copies: MoveStore's held bytes and its signer's (library copies are not ours).
    const copies = made.flatMap(({ copy, by }) =>
      (by.includes('MoveStore.tsx') || by.includes('signer.ts')) &&
      copy.length === 32 &&
      copy.every((byte, index) => byte === firstKey[index])
        ? [copy]
        : [],
    );
    from.mockRestore();
    expect(copies).toHaveLength(2);
    await signPayoutFor(container, getPublicKey(firstKey));
    await confirmAndMove(container);
    await settle(() => text(container).includes(errorMessage(new ApiError(0, 'network'))));
    expect(tried).toHaveLength(2);
    const [firstSigner] = newOwners;
    if (firstSigner === undefined) {
      throw new Error('no signer');
    }
    // Held until Cancel: the first key still signs.
    expect((await firstSigner.signEvent(authorizationTemplate())).pubkey).toBe(
      getPublicKey(firstKey),
    );
    // Cancel, then another key: the held move of the first key is not sent again.
    await click(buttonNamed(container, 'Cancel'));
    // Cancel closed the first key: it signs nothing more.
    await expect(firstSigner.signEvent(authorizationTemplate())).rejects.toThrow('signed out');
    // And every copy of its bytes is zeroed.
    for (const copy of copies) {
      expect(copy.every((byte) => byte === 0)).toBe(true);
    }
    online = true;
    await chooseNewKey(container, secondKey);
    await signPayoutFor(container, getPublicKey(secondKey));
    await confirmAndMove(container);
    await settle(() => text(container).includes(MOVED_TITLE));
    expect(server.prepares.map((input) => input.to)).toEqual([
      getPublicKey(firstKey),
      getPublicKey(secondKey),
    ]);
    expect(tried).toHaveLength(3);
    expect(tried[2]?.to).toBe(getPublicKey(secondKey));
    expect(tried[2]?.payto.pubkey).toBe(getPublicKey(secondKey));
  });

  it('drops a held move when the key step is cancelled too, then prepares for the key chosen next', async () => {
    const firstKey = generateSecretKey();
    const secondKey = generateSecretKey();
    const server = moveServer();
    const tried: MoveInput[] = [];
    let online = false;
    const { container } = await openSettings(activeView(), {
      ...server.api,
      move: async (input) => {
        tried.push(input);
        if (!online) {
          throw new TypeError('Failed to fetch');
        }
        return { request: { id: 'r1', state: 'pending' } };
      },
    });
    await chooseNewKey(container, firstKey);
    await signPayoutFor(container, getPublicKey(firstKey));
    await confirmAndMove(container);
    await settle(() => tried.length === 2 && !buttonNamed(container, 'Move store').disabled);
    await click(buttonNamed(container, 'Cancel'));
    await click(buttonNamed(container, 'Move to a new owner key'));
    await click(buttonNamed(container, 'Cancel'));
    online = true;
    await chooseNewKey(container, secondKey);
    await signPayoutFor(container, getPublicKey(secondKey));
    await confirmAndMove(container);
    await settle(() => text(container).includes(MOVED_TITLE));
    expect(server.prepares).toHaveLength(2);
    expect(server.prepares[1]?.to).toBe(getPublicKey(secondKey));
    expect(tried[2]?.to).toBe(getPublicKey(secondKey));
  });

  it('keeps a move with no answer: the next press sends it again, with no new prepare', async () => {
    const newKey = generateSecretKey();
    const server = moveServer();
    const tried: MoveInput[] = [];
    const signers: string[] = [];
    let online = false;
    const { container } = await openSettings(activeView(), {
      ...server.api,
      move: async (input, newOwner) => {
        tried.push(input);
        signers.push(newOwner.pubkey);
        if (!online) {
          throw new ApiError(0, 'network');
        }
        return { alreadyMoved: true, requestId: null };
      },
    });
    await chooseNewKey(container, newKey);
    await signPayoutFor(container, getPublicKey(newKey));
    await confirmAndMove(container);
    await settle(() => text(container).includes(errorMessage(new ApiError(0, 'network'))));
    expect(tried).toHaveLength(2);
    expect(text(container)).not.toContain(MOVED_TITLE);
    online = true;
    await click(buttonNamed(container, 'Move store'));
    await settle(() => text(container).includes(MOVED_TITLE));
    expect(server.prepares).toHaveLength(1);
    expect(tried).toHaveLength(3);
    expect(tried[2]).toEqual(tried[0]);
    expect(signers).toEqual([getPublicKey(newKey), getPublicKey(newKey), getPublicKey(newKey)]);
    expect(text(container)).toContain(MOVED_DONE);
  });

  it('signs with the wallet for the new key, and moves the active payouts, not the saved draft', async () => {
    const newKey = generateSecretKey();
    const newOwner = getPublicKey(newKey);
    const key = solanaKey();
    const wallet = fakeSolanaWallet({ name: 'Test Wallet', accounts: [key] });
    removers.push(injectStandardWallet(window, wallet));
    const active: Payout[] = [{ caip19: SOLANA_USDC, address: key.address, signature: 'old' }];
    const view = storeView({
      status: 'active',
      config: storeConfig({ draftPayouts: PAYOUTS, revision: 3 }),
      activePayouts: { createdAt: NOW - 100, payouts: active },
    });
    expect(currentPayouts(view)).toEqual(active);
    const server = moveServer();
    const { container } = await openSettings(view, server.api);
    await chooseNewKey(container, newKey);
    expect(text(container)).toContain(key.address);
    expect(text(container)).not.toContain(EVM.lower);
    await settle(() => hasButton(container, 'Sign with Test Wallet'));
    await click(buttonNamed(container, 'Sign with Test Wallet'));
    await settle(
      () =>
        container.querySelector('#move-payout-state-0')?.textContent === 'Signed for the new key',
    );
    expect(wallet.signedTexts).toEqual([proofMessage(newOwner, SOLANA_USDC)]);
    await confirmAndMove(container);
    await settle(() => text(container).includes(MOVED_TITLE));
    expect(server.prepares[0]?.payouts).toEqual([
      { caip19: SOLANA_USDC, address: key.address, signature: expect.any(String) },
    ]);
  });

  it('signs nothing the page did not expect', async () => {
    const newKey = generateSecretKey();
    const other = evmKey();
    const cases: [string, (input: MovePrepareInput) => MoveTemplates][] = [
      [
        TEMPLATE_PROBLEMS.payouts,
        (input) => ({
          ...prepared(input),
          payto: payoutListTemplate([
            { caip19: BASE_SEPOLIA_USDC, address: other.lower, signature: 'old-sig' },
          ]),
        }),
      ],
      [
        TEMPLATE_PROBLEMS.operator,
        (input) => ({
          ...prepared(input),
          auth: {
            ...authorizationTemplate(),
            tags: [
              ['d', STORE_PUBKEY],
              ['p', STORE_PUBKEY],
              ['mode', 'hosted', 'evil.example'],
            ],
          },
        }),
      ],
      [
        BAD_REVOCATION,
        (input) => ({ ...prepared(input), revocation: revocationTemplate(NOW + 3600) }),
      ],
      [
        BAD_REVOCATION,
        (input) => ({
          ...prepared(input),
          revocation: { ...revocationTemplate(), tags: [['d', STORE_PUBKEY]] },
        }),
      ],
      [
        BAD_REVOCATION,
        (input) => ({ ...prepared(input), revocation: { ...revocationTemplate(), content: 'x' } }),
      ],
      [
        BAD_REVOCATION,
        (input) => ({ ...prepared(input), revocation: { ...revocationTemplate(), kind: 10133 } }),
      ],
    ];
    for (const [sentence, prepare] of cases) {
      const move = vi.fn();
      const { container, fake } = await openSettings(activeView(), {
        prepareMove: async (input) => prepare(input),
        move,
      });
      await chooseNewKey(container, newKey);
      await signPayoutFor(container, getPublicKey(newKey));
      await confirmAndMove(container);
      await settle(() => text(container).includes(sentence));
      expect(move).not.toHaveBeenCalled();
      expect(fake.signEvent).not.toHaveBeenCalled();
      await mounted?.unmount();
      mounted = undefined;
    }
  });

  it('reads the answer: a request to follow, none for a pending store, the same move again', () => {
    const pending = { request: { id: 'r1', state: 'pending' as const } };
    expect(moveOutcome(pending, false)).toEqual({ kind: 'follow', requestId: 'r1' });
    expect(moveOutcome({ request: null }, true)).toEqual({ kind: 'on_activation' });
    expect(moveOutcome({ request: null }, false)).toEqual({ kind: 'done' });
    expect(moveOutcome({ alreadyMoved: true, requestId: 'r1' }, false)).toEqual({
      kind: 'follow',
      requestId: 'r1',
    });
    expect(moveOutcome({ alreadyMoved: true, requestId: null }, true)).toEqual({
      kind: 'on_activation',
    });
    expect(moveOutcome({ alreadyMoved: true, requestId: null }, false)).toEqual({ kind: 'done' });
    const failed = {
      request: {
        id: 'r1',
        kind: 'setup',
        state: 'failed' as const,
        result: { code: 'setup_failed' },
        createdAt: NOW,
        appliedAt: null,
      },
    };
    expect(moveOutcome(failed, false)).toEqual({
      kind: 'failed',
      message: expect.stringContaining('could not apply'),
    });
    expect(errorMessage(new ApiError(401, 'unauthorized', { reason: 'new_owner' }))).toBe(
      'The move was not signed by the new owner key. Retry.',
    );
  });

  it('checks the payout list as a set, whatever order the server built', () => {
    const second: Payout = { caip19: 'solana:x/token:y', address: 'Sol', signature: 's2' };
    const payouts = [...PAYOUTS, second];
    const input = { to: OWNER, payouts };
    const reversed = { ...prepared(input), payto: payoutListTemplate([second, ...PAYOUTS]) };
    const base = { payouts, storePubkey: STORE_PUBKEY, operator: OPERATOR, localNow: NOW };
    expect(checkMoveTemplates({ ...base, prepared: reversed }).ok).toBe(true);
    const missing = { ...prepared(input), payto: payoutListTemplate([second]) };
    expect(checkMoveTemplates({ ...base, prepared: missing })).toEqual({
      ok: false,
      message: TEMPLATE_PROBLEMS.payouts,
    });
    const doubled = { ...prepared(input), payto: payoutListTemplate([second, second]) };
    expect(checkMoveTemplates({ ...base, prepared: doubled }).ok).toBe(false);
  });
});

describe('while the store switches to the new key', () => {
  it('says so on every tab, hides payout edits, and follows the move request until it is applied', async () => {
    const switching = activeView({ switching: true });
    let applied = false;
    let reads = 0;
    const fake = fakeSession({
      store: vi.fn(async () => (applied ? activeView() : switching)),
      request: async (id) => {
        reads += 1;
        expect(id).toBe('r1');
        return {
          request: {
            id,
            kind: 'setup',
            state: applied ? 'applied' : 'pending',
            result: null,
            createdAt: NOW,
            appliedAt: applied ? NOW : null,
          },
        };
      },
    });
    fake.session.meta = META_ON;
    // The follow waits between reads until the test lets it go on.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.session.sleep = () => gate;
    mounted = await mount(
      <StoreShell
        session={fake.session}
        store={switching}
        onSignOut={vi.fn()}
        moveRequestId="r1"
      />,
    );
    const { container } = mounted;
    expect(text(container)).toContain(SWITCHING_TITLE);
    await click(buttonNamed(container, 'Payouts'));
    expect(text(container)).toContain(PAYOUTS_WAIT_FOR_SWITCH);
    expect(hasButton(container, 'Save payouts')).toBe(false);
    expect(hasButton(container, 'Publish payout list')).toBe(false);
    await click(buttonNamed(container, 'Overview'));
    expect(text(container)).not.toContain('Only you can change it.');
    expect(reads).toBe(0);
    // Applied: the store is read again and no longer switching.
    applied = true;
    release();
    await settle(() => !text(container).includes(SWITCHING_TITLE));
    expect(reads).toBe(1);
    expect(fake.api.store).toHaveBeenCalled();
    expect(text(container)).toContain('Only you can change it.');
  });

  it('says a failed move request in a fixed sentence', async () => {
    const fake = fakeSession({
      store: async () => activeView(),
      request: async (id) => ({
        request: {
          id,
          kind: 'setup',
          state: 'failed',
          result: { code: 'setup_failed', message: 'SECRET' },
          createdAt: NOW,
          appliedAt: null,
        },
      }),
    });
    mounted = await mount(
      <StoreShell
        session={fake.session}
        store={activeView()}
        onSignOut={vi.fn()}
        moveRequestId="r9"
      />,
    );
    await settle(() => text(mounted?.container ?? document.body).includes('could not apply'));
    expect(text(mounted.container)).not.toContain('SECRET');
  });
});

describe('the session across a move', () => {
  const CONFIGURED = readHostedConfig(CONFIG.apiBase, CONFIG.operator);

  it('goes on as the new owner: O is closed, and the new key reads the store and follows the request', async () => {
    const newKey = generateSecretKey();
    const newOwner = getPublicKey(newKey);
    // The session dates by the real clock: templates from now.
    const server = moveServer(
      { request: { id: 'r1', state: 'pending' } },
      true,
      Math.floor(Date.now() / 1000),
    );
    const oldApi = storeApi({
      meta: async () => META_ON,
      store: async () => activeView(),
      ...server.api,
    });
    const requests: string[] = [];
    const newApi = storeApi({
      meta: async () => META_ON,
      store: async () => activeView({ owner: newOwner, switching: requests.length === 0 }),
      request: async (id) => {
        requests.push(id);
        return {
          request: {
            id,
            kind: 'setup',
            state: 'applied',
            result: null,
            createdAt: NOW,
            appliedAt: NOW,
          },
        };
      },
    });
    const signers: Signer[] = [];
    const createApi = vi.fn((signer: Signer) => {
      signers.push(signer);
      return signer.pubkey === OWNER ? oldApi : newApi;
    });
    mounted = await mount(
      <HostedApp ownTab config={CONFIGURED} createApi={createApi} leave={vi.fn()} />,
    );
    const { container } = mounted;
    await click(inputById(container, 'sign-in-remember'));
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => hasButton(container, 'Settings'));
    await click(buttonNamed(container, 'Settings'));
    await chooseNewKey(container, newKey);
    await signPayoutFor(container, newOwner);
    await confirmAndMove(container);
    await settle(() => hasButton(container, 'Continue with the new key'));
    await click(inputById(container, 'move-key-remember'));
    await click(buttonNamed(container, 'Continue with the new key'));
    // The real wait between reads of a followed request: 2 s.
    await settle(() => requests.length === 1, 800);
    expect(requests).toEqual(['r1']);
    expect(signers.map((signer) => signer.pubkey)).toEqual([OWNER, newOwner]);
    await expect(signers[0]?.signEvent(authorizationTemplate())).rejects.toThrow();
    const signedAsNew: NostrEvent | undefined =
      await signers[1]?.signEvent(authorizationTemplate());
    expect(signedAsNew?.pubkey).toBe(newOwner);
    expect(sessionStorage.getItem('paycore-hosted.tab-session')).toContain(newOwner);
  });

  it('a moved owner key signing in reads that the store moved', async () => {
    const api = storeApi({
      meta: async () => META_ON,
      store: async () => {
        throw new ApiError(409, 'moved');
      },
    });
    mounted = await mount(
      <HostedApp ownTab config={CONFIGURED} createApi={() => api} leave={vi.fn()} />,
    );
    const { container } = mounted;
    await click(inputById(container, 'sign-in-remember'));
    inputById(container, 'owner-key').value = nip19.nsecEncode(OWNER_KEY);
    await click(buttonNamed(container, 'Sign in'));
    await settle(() => text(container).includes(MOVED_KEY));
    expect(text(container)).toContain('This store moved');
    expect(hasButton(container, 'Retry')).toBe(false);
    expect(hasButton(container, 'Sign out')).toBe(true);
  });
});
