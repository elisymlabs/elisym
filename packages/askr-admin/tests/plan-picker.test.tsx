import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalogAuth, buildConfigEvent } from '@elisym/askr';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedSection } from '../src/components/EmbedSection';
import { Overview } from '../src/components/Overview';
import { Session } from '../src/components/Session';
import { SettingsSection } from '../src/components/SettingsSection';
import { CONTACT_URL, PRICING_URL } from '../src/constants';
import { PENDING_CONTACT_TEXT, PENDING_OVERVIEW_TEXT, PENDING_TEXT } from '../src/lib/activation';
import { ApiError } from '../src/lib/api';
import type { AdminClient } from '../src/lib/deps';
import { errorMessage } from '../src/lib/errors';
import { HELP } from '../src/lib/help';
import { PLANS } from '../src/lib/plans';
import { savedMessage } from '../src/lib/save';
import type { StoreView } from '../src/lib/types';
import {
  ASSISTANT,
  FREE_TIER,
  NOW,
  OWNER_KEY,
  PINNED_WIDGET,
  SERVER_KEY,
  adminConfig,
  fakeApi,
  fakeReader,
  overviewProps,
  sessionDeps,
  storeView,
} from './fakes';
import { type Mounted, buttonNamed, byId, click, mount, settle } from './mount';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

const FREE_UNAVAILABLE = 'Free is not available right now. Message us with your Store ID.';

const choosingView = (overrides: Partial<StoreView> = {}) =>
  storeView({ status: 'pending', tier: null, ...overrides });

function configSignedBy(name: string, createdAt: number): NostrEvent {
  return finalizeEvent(
    {
      ...buildConfigEvent(
        {
          assistant: ASSISTANT,
          origins: ['https://tea.example'],
          name,
          language: 'en',
          currency: 'USD',
          source: { kind: 'admin' },
          catalogKey: SERVER_KEY,
        },
        OWNER_KEY,
      ),
      created_at: createdAt,
    },
    OWNER_KEY,
  );
}

function serverAuthorization(createdAt: number): NostrEvent {
  return finalizeEvent(
    { ...buildCatalogAuth({ key: SERVER_KEY, mode: 'hosted' }), created_at: createdAt },
    OWNER_KEY,
  );
}

function fieldValue(container: HTMLElement, id: string): string {
  const field = byId(container, id);
  return field instanceof HTMLInputElement ? field.value : '';
}

async function mountOverview(
  options: {
    api?: AdminClient;
    view?: StoreView;
    configured?: boolean;
    configError?: string;
    onPlanChosen?: () => Promise<void>;
  } = {},
) {
  const props = overviewProps(options.api);
  const onPlanChosen = options.onPlanChosen ?? props.onPlanChosen;
  mounted = await mount(
    <Overview
      deps={props.deps}
      view={options.view ?? choosingView()}
      config={options.configured === false ? undefined : adminConfig()}
      configFromServer
      configError={options.configError ?? ''}
      onPlanChosen={onPlanChosen}
    />,
  );
  return { container: mounted.container, onPlanChosen };
}

async function mountSession(api: AdminClient, relay: NostrEvent[] = []) {
  mounted = await mount(
    <Session
      deps={sessionDeps(api, fakeReader(relay))}
      onSignOut={() => undefined}
      onReplaceKey={() => undefined}
    />,
  );
  const { container } = mounted;
  await settle(() => /Overview|Set up your assistant|could not/.test(container.textContent ?? ''));
  return container;
}

async function openTab(container: HTMLElement, label: string) {
  const tab = [...container.querySelectorAll('nav[aria-label="Sections"] button')].find(
    (button) => button.textContent === label,
  );
  if (!(tab instanceof HTMLButtonElement)) {
    throw new Error(`no tab ${label}`);
  }
  await click(tab);
}

describe('the plan picker (6.5)', () => {
  it('shows the landing plans with monthly prices, the sizes as one card, Enterprise from its floor', async () => {
    const { container } = await mountOverview();
    const picker = byId(container, 'plan-picker');
    const text = picker.textContent ?? '';
    expect(text).toContain('Free$0 a month');
    expect(text).toContain('Starter$29 a month');
    expect(text).toContain('Growth / Pro / Scale');
    expect(text).toContain('Growth: $99 a month');
    expect(text).toContain('Pro: $199 a month');
    expect(text).toContain('Scale: $499 a month');
    expect(text).toContain('Enterprisefrom $1,500 a month');
    expect(text).toContain('For a paid plan, message us with your Store ID');
    expect(picker.querySelectorAll('.contact-link')).toHaveLength(1);
    expect(picker.querySelector('.contact-link')?.getAttribute('href')).toBe(CONTACT_URL);
    expect([...picker.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toContain(
      PRICING_URL,
    );
    expect(text).not.toContain('yearly');
  });

  it('keeps Start on Free disabled with "Save your settings first" while no settings exist', async () => {
    const api = fakeApi();
    const { container } = await mountOverview({ api, configured: false });
    const start = buttonNamed(container, 'Start on Free');
    expect(start.disabled).toBe(true);
    expect(byId(container, 'plan-picker').textContent).toContain('Save your settings first.');
    await click(start);
    expect(api.choosePlan).not.toHaveBeenCalled();
  });

  it('keeps Start on Free enabled when the settings could not be read, showing that error instead', async () => {
    const configError = 'Your saved settings could not be read: the server could not be reached.';
    const { container } = await mountOverview({ configured: false, configError });
    const start = buttonNamed(container, 'Start on Free');
    expect(start.disabled).toBe(false);
    const picker = byId(container, 'plan-picker').textContent ?? '';
    expect(picker).toContain(configError);
    expect(picker).not.toContain('Save your settings first');
  });

  it('chooses Free, then reads the store and its settings again', async () => {
    const api = fakeApi();
    const onPlanChosen = vi.fn(async () => undefined);
    const { container } = await mountOverview({ api, onPlanChosen });
    await click(buttonNamed(container, 'Start on Free'));
    await settle(() => onPlanChosen.mock.calls.length === 1);
    expect(api.choosePlan).toHaveBeenCalledWith('free');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ['capacity_reached', FREE_UNAVAILABLE],
    ['free_unavailable', FREE_UNAVAILABLE],
    ['no_settings', 'Save your settings first.'],
    ['read_failed', errorMessage(new ApiError(503, 'read_failed'))],
    ['network', errorMessage(new ApiError(0, 'network'))],
  ])('shows what %s means, and reads nothing again', async (code, text) => {
    const api = fakeApi({
      choosePlan: vi.fn(async () => Promise.reject(new ApiError(409, code))),
    });
    const onPlanChosen = vi.fn(async () => undefined);
    const { container } = await mountOverview({ api, onPlanChosen });
    await click(buttonNamed(container, 'Start on Free'));
    await settle(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(text);
    expect(onPlanChosen).not.toHaveBeenCalled();
    // The contact links stay the picker's one line, whatever the error.
    expect(container.querySelectorAll('.contact-link')).toHaveLength(1);
  });

  it("read_failed shows the server code's own text", () => {
    expect(errorMessage(new ApiError(503, 'read_failed'))).toBe(
      "Your store's settings could not be read just now. Retry in a moment.",
    );
  });

  it.each([
    ['not_pending', storeView({ status: 'suspended' }), 'Contact the Askr operator'],
    ['operator_managed', storeView({ status: 'pending' }), PENDING_CONTACT_TEXT],
  ] as const)(
    'on %s (the store changed meanwhile) reads it again and shows its new status',
    async (code, after, status) => {
      let view = choosingView({ events: { pending: 1, failing: [] } });
      const api = fakeApi({
        store: vi.fn(async () => view),
        storedEvents: vi.fn(async () => ({
          events: [configSignedBy('Stored', NOW - 5)],
          truncated: false,
        })),
        choosePlan: vi.fn(async () => {
          view = after;
          return Promise.reject(new ApiError(409, code));
        }),
      });
      const container = await mountSession(api);
      await click(buttonNamed(container, 'Start on Free'));
      await settle(() => (container.textContent ?? '').includes(status));
      expect(container.querySelector('#plan-picker')).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );
});

describe('Start on Free in a session (6.5)', () => {
  it('refreshes to the active view, and shows the signed settings until the relay has them', async () => {
    const stored = [configSignedBy('Signed Tea', NOW - 5), serverAuthorization(NOW - 5)];
    let view = choosingView({ events: { pending: 2, failing: [] } });
    const api = fakeApi({
      store: vi.fn(async () => view),
      storedEvents: vi.fn(async () => ({ events: stored, truncated: false })),
      choosePlan: vi.fn(async () => {
        view = storeView({ tier: { ...FREE_TIER }, events: { pending: 2, failing: [] } });
        return { ...view, activation: 'activated' as const };
      }),
    });
    // The relay has nothing yet: activation publishes a moment later.
    const container = await mountSession(api);
    expect(container.textContent).toContain(PENDING_OVERVIEW_TEXT);
    const storeReads = vi.mocked(api.store).mock.calls.length;
    const storedReads = vi.mocked(api.storedEvents).mock.calls.length;
    await click(buttonNamed(container, 'Start on Free'));
    await settle(() => (container.textContent ?? '').includes('Plan: free'));
    // Shell's refresh: the view and the settings, both read again.
    expect(vi.mocked(api.store).mock.calls.length).toBe(storeReads + 1);
    expect(vi.mocked(api.storedEvents).mock.calls.length).toBe(storedReads + 1);
    expect(container.querySelector('#plan-picker')).toBeNull();
    expect(container.querySelector('#sidebar-store-name')?.textContent).toBe('Signed Tea');
    expect(container.textContent).toContain('Your settings are shown as you signed them.');
    expect(container.textContent).toContain('They are being published now.');
    expect(container.textContent).not.toContain('Your settings are not published yet');
    await openTab(container, 'Settings');
    await settle(() => container.querySelector('#store-name') !== null);
    // The form is the signed config, not an empty one a save would sign over it.
    expect(fieldValue(container, 'store-name')).toBe('Signed Tea');
  });

  it('reads the relay alone once nothing is pending', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ events: { pending: 0, failing: [] } })),
      storedEvents: vi.fn(async () => ({
        events: [configSignedBy('Stored', NOW)],
        truncated: false,
      })),
    });
    const container = await mountSession(api, [configSignedBy('Relay', NOW - 10)]);
    expect(container.querySelector('#sidebar-store-name')?.textContent).toBe('Relay');
    expect(api.storedEvents).not.toHaveBeenCalled();
  });

  it('an active store with events pending falls back to the relay, with no error, when the read-back fails', async () => {
    const api = fakeApi({
      store: vi.fn(async () => storeView({ events: { pending: 1, failing: [] } })),
      storedEvents: vi.fn(async () => Promise.reject(new ApiError(0, 'network'))),
    });
    const container = await mountSession(api, [configSignedBy('Relay', NOW - 10)]);
    expect(api.storedEvents).toHaveBeenCalled();
    expect(container.querySelector('#sidebar-store-name')?.textContent).toBe('Relay');
    expect(container.textContent).not.toContain('could not be read');
    expect(container.textContent).not.toContain('shown as you signed them');
  });
});

/** The landing's plans, read from its source (tests run from the package's own folder): the admin cannot import it. */
function landingPlans() {
  const source = readFileSync(join(process.cwd(), '../askr-landing/src/constants.ts'), 'utf8');
  const start = source.indexOf('export const PLANS');
  const end = source.indexOf('];', start);
  const table = source.slice(start, end);
  return table
    .split(/\n {2}\{\n/u)
    .slice(1)
    .map((block) => {
      const name = /\n {4}name: '([^']+)'/u.exec(`\n${block}`)?.[1];
      const price = /price: \{ kind: '(flat|from)', monthly: '([^']+)'/u.exec(block);
      const yearly = /yearlyPerMonth: '([^']+)', yearlyTotal: '([^']+)'/u.exec(block);
      const starts = /\n {4}start: '([a-z]+)'/u.exec(`\n${block}`)?.[1];
      const group = /\n {4}group: '([a-z]+)'/u.exec(`\n${block}`)?.[1];
      return {
        name,
        monthly: price?.[2],
        ...(yearly === null ? {} : { yearlyPerMonth: yearly[1], yearlyTotal: yearly[2] }),
        start: starts,
        ...(group === undefined ? {} : { group }),
        ...(price?.[1] === 'from' ? { from: true } : {}),
      };
    });
}

describe('the plan constant (6.5)', () => {
  it("equals the landing's plans: names, order, monthly prices, the sizes group and Enterprise's floor", () => {
    const landing = landingPlans();
    expect(landing).toHaveLength(6);
    expect(PLANS).toEqual(landing);
    expect(PLANS.find((plan) => plan.name === 'Enterprise')?.from).toBe(true);
    expect(PLANS.filter((plan) => plan.group === 'sizes').map((plan) => plan.name)).toEqual([
      'Growth',
      'Pro',
      'Scale',
    ]);
  });
});

const RETRY_WORDING = /save (your settings )?again/iu;

function promisesRetry(text: string): boolean {
  return (
    (RETRY_WORDING.test(text) && /activat/iu.test(text)) || /waiting for activation/iu.test(text)
  );
}

describe('no admin text says to save again for an activation (6.5)', () => {
  it('in the wording sources: activation texts, error codes, help and every saved message', async () => {
    const activationSource = readFileSync(join(process.cwd(), 'src/lib/activation.ts'), 'utf8');
    const errorsSource = readFileSync(join(process.cwd(), 'src/lib/errors.ts'), 'utf8');
    const helpTexts = Object.values(HELP).map((help) => help.text);
    const saved = (['pending', 'active', 'suspended'] as const).flatMap((status) => [
      savedMessage({ status, tier: null }),
      savedMessage({ status, tier: { ...FREE_TIER } }),
    ]);
    const texts = [
      activationSource,
      errorsSource,
      ...helpTexts,
      ...saved,
      PENDING_TEXT,
      PENDING_OVERVIEW_TEXT,
      PENDING_CONTACT_TEXT,
    ];
    for (const text of texts) {
      expect(promisesRetry(text), text).toBe(false);
    }
  });

  it('in the Overview, Embed and Settings sections a pending store shows', async () => {
    for (const view of [choosingView(), storeView({ status: 'pending' })]) {
      const api = fakeApi({ pinnedWidget: vi.fn(async () => PINNED_WIDGET) });
      const deps = sessionDeps(api, fakeReader([]));
      mounted = await mount(
        <div>
          <Overview {...overviewProps(api)} view={view} config={adminConfig()} configFromServer />
          <EmbedSection api={api} view={view} config={adminConfig()} />
          <SettingsSection
            deps={deps}
            view={view}
            config={adminConfig()}
            configError=""
            onRetry={async () => undefined}
            onSaved={async () => undefined}
          />
        </div>,
      );
      const { container } = mounted;
      await settle(() => container.querySelector('#store-name') !== null);
      const text = container.textContent ?? '';
      expect(promisesRetry(text), text).toBe(false);
      // The Embed tab says where to choose the plan; Overview says the picker is below.
      if (view.tier === null) {
        expect(text).toContain(PENDING_TEXT);
        expect(text).toContain(PENDING_OVERVIEW_TEXT);
      } else {
        expect(text).toContain(PENDING_CONTACT_TEXT);
      }
      await mounted.unmount();
      mounted = undefined;
    }
  });
});
