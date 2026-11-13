import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiAnswer, ConsoleApi } from '../../src/cloud/lib/api';
import {
  STATUS_POLL_MS,
  STATUS_WATCH_MS,
  type StoreStatusPoll,
  useStatus,
} from '../../src/cloud/lib/use-status';

const DIGEST = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

function statusBody(name: string | null) {
  return {
    tenantId: 'aaaaaaaaaaaa',
    tier: 'starter',
    tierName: 'Starter',
    effectivePaidUntil: null,
    storePubkey: null,
    productCount: 0,
    pending: false,
    kept: { name, rails: [], payoutList: null, productsDigest: DIGEST },
    ownerRefusal: null,
    resignInFlight: false,
    lastProblems: { store: null, 'owner-events': null, products: null },
    runState: 'not_launched',
    gates: {
      activation: 'not_paid',
      noCyclePending: true,
      homeReady: false,
      storeSetUp: false,
      domainSet: false,
    },
    usage: { month: '2027-01', paidOrders: 0, ordersPerMonth: 2000, products: 100 },
  };
}

let mounted: Root | undefined;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
});

/** A ConsoleApi whose answers the test hands back one at a time, in any order. */
function heldApi() {
  const waiting: ((answer: ApiAnswer) => void)[] = [];
  const api: ConsoleApi = {
    request: (_method: string, _path: string) =>
      new Promise<ApiAnswer>((resolve) => waiting.push(resolve)),
    requestBytes: async () => ({ status: 0, bytes: new Uint8Array(), body: undefined }),
    serverNow: () => undefined,
  };
  return { api, waiting };
}

interface Props {
  api: ConsoleApi;
  nowMs: () => number;
  onPoll: (poll: StoreStatusPoll) => void;
}

function Probe({ api, nowMs, onPoll }: Props) {
  onPoll(useStatus(api, 'aaaaaaaaaaaa', nowMs));
  return null;
}

describe('the status poll', () => {
  it('lets only the newest read count, numbers it, and stops after its watch', async () => {
    const { api, waiting } = heldApi();
    let clock = 0;
    let poll: StoreStatusPoll | undefined;
    const host = document.createElement('div');
    mounted = createRoot(host);
    act(() =>
      mounted?.render(<Probe api={api} nowMs={() => clock} onPoll={(each) => (poll = each)} />),
    );
    // Read 1 is on its way; a watch asks read 2.
    let asked = 0;
    act(() => {
      asked = poll?.watch() ?? 0;
    });
    expect(asked).toBe(2);
    // Read 2 lands first, then the older read 1: only read 2 counts.
    await act(async () => waiting[1]?.({ status: 200, body: statusBody('New') }));
    expect(poll?.statusSeq).toBe(2);
    await act(async () => waiting[0]?.({ status: 200, body: statusBody('Old') }));
    expect(poll?.statusSeq).toBe(2);
    expect(poll?.status?.gone === false ? poll.status.kept.name : undefined).toBe('New');
    // Past its watch, the next tick stops the poll instead of reading.
    clock = STATUS_WATCH_MS;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS + 50));
    });
    expect(poll?.expired).toBe(true);
    expect(waiting).toHaveLength(2);
    act(() => {
      poll?.watch();
    });
    expect(poll?.expired).toBe(false);
    expect(waiting).toHaveLength(3);
  }, 10_000);
});
