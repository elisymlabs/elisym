import { ChatClient } from './client';
import { httpGateway } from './gateway';
import { connectNostrRelay } from './relay';
import { storageArea } from './storage';

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
