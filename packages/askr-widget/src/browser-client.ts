import { ChatClient } from './client';
import { httpGateway } from './gateway';
import { connectNostrRelay } from './relay';
import { storageArea } from './storage';
import { type StoreCheck, checkStore } from './store-check';

/** A chat client wired to the real relay, gateway and browser storage. */
export function createBrowserClient(owner: string): ChatClient {
  return new ChatClient({
    owner,
    connect: connectNostrRelay,
    gateway: httpGateway(),
    localStorage: storageArea('localStorage'),
    sessionStorage: storageArea('sessionStorage'),
    pageUrl: () => globalThis.location?.href,
    locale: () => globalThis.navigator?.language,
  });
}

/** Whether the widget shows for a store, checked against the real relay and gateway (B). */
export function checkBrowserStore(owner: string): Promise<StoreCheck> {
  return checkStore(owner, {
    connect: connectNostrRelay,
    gateway: httpGateway(),
    storage: storageArea('sessionStorage'),
  });
}
