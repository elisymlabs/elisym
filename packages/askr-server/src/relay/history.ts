import type { Filter, NostrEvent } from 'nostr-tools';
import { EOSE_TIMEOUT_MS, LIBRARY_EOSE_TIMEOUT_MS } from '../constants';
import type { RelayLike } from './pool';

export interface HistoryRead {
  /** Resolves `true` after a real EOSE, `false` on a close, a timeout or a refused REQ. */
  done: Promise<boolean>;
  close: () => void;
}

/**
 * Open a history-reading REQ (2.4) with `AbstractRelay.subscribe`, never the
 * pool's `subscribeMany`, whose `oneose` also fires on its timeout and on a
 * disconnect. An `oneose` counts as a real EOSE only before this
 * subscription's `onclose` and before our own timer; nostr-tools does not clear
 * its `eoseTimeout` on close, so a later `oneose` is ignored. A REQ with no real
 * EOSE in time (also a REQ the relay refused with only a NOTICE) is CLOSEd and
 * reported as failed, so the caller reopens it after the backoff.
 */
export function readHistory(
  relay: RelayLike,
  filters: Filter[],
  onEvent: (event: NostrEvent) => void,
  options: {
    alreadyHaveEvent?: (id: string) => boolean;
    /** An event the library refused (signature or filter): still sent by the relay. */
    onInvalidEvent?: () => void;
    timeoutMs?: number;
    /** Called on every close, also after the EOSE (a live REQ that dropped). */
    onClose?: () => void;
  } = {},
): HistoryRead {
  let settled = false;
  let resolveDone: (real: boolean) => void = () => undefined;
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });
  const settle = (real: boolean) => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      resolveDone(real);
    }
  };
  const subscription = relay.subscribe(filters, {
    onevent: onEvent,
    oneose: () => settle(true),
    onclose: () => {
      settle(false);
      options.onClose?.();
    },
    eoseTimeout: LIBRARY_EOSE_TIMEOUT_MS,
    ...(options.alreadyHaveEvent ? { alreadyHaveEvent: options.alreadyHaveEvent } : {}),
    ...(options.onInvalidEvent ? { oninvalidevent: options.onInvalidEvent } : {}),
  });
  const timer = setTimeout(() => {
    settle(false);
    subscription.close();
  }, options.timeoutMs ?? EOSE_TIMEOUT_MS);
  return {
    done,
    close: () => {
      settle(false);
      subscription.close();
    },
  };
}
