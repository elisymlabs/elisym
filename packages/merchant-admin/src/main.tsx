import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { CloudProps } from './cloud/CloudApp';
import { downloadFile } from './cloud/lib/download';
import { consoleRelayQuery } from './cloud/lib/key-in-use';
import { billingUrlFrom, cloudApiOriginOf } from './cloud/lib/origin';
import { checkoutReturnOf, startTierOf } from './cloud/lib/start';
import { injectedProviders } from './cloud/lib/wallet';
import { TERMS_URL } from './constants';
import { createSessionDeps } from './lib/deps';
import { claimWindow } from './lib/own-tab';
import { Root } from './Root';

const ownTab = claimWindow(window);
const checkoutReturn = checkoutReturnOf(window.location.href);
// Read once: a reload or a later sign-in does not say it again.
if (checkoutReturn !== undefined) {
  window.history.replaceState(null, '', window.location.pathname);
}
// Built without a cloud-api origin, the admin is for self-hosted stores only.
const apiOrigin = cloudApiOriginOf(import.meta.env.VITE_CLOUD_API_ORIGIN);
const cloud: CloudProps | undefined =
  apiOrigin === undefined
    ? undefined
    : {
        apiOrigin,
        download: (data, fileName) => downloadFile(document, data, fileName),
        relayQuery: consoleRelayQuery(),
        startTier: startTierOf(window.location.href),
        termsUrl: TERMS_URL,
        billingUrl: billingUrlFrom(import.meta.env.VITE_BILLING_URL),
        navigate: (url) => window.location.assign(url),
        checkoutReturn,
        wallets: injectedProviders(window),
      };
const root = document.getElementById('root');
if (root === null) {
  throw new Error('the admin page has no #root');
}
createRoot(root).render(
  <StrictMode>
    <Root
      ownTab={ownTab}
      createDeps={createSessionDeps}
      leave={() => window.location.replace(`${window.location.origin}/`)}
      cloud={cloud}
    />
  </StrictMode>,
);
