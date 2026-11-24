import '../app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { claimWindow } from '../lib/own-tab';
import { HostedApp } from './App';
import { PAYCORE_API_BASE, PAYCORE_OPERATOR } from './config';
import { createHostedApi } from './lib/api';
import { readHostedConfig } from './lib/hosted-config';

const ownTab = claimWindow(window);
const root = document.getElementById('root');
if (root === null) {
  throw new Error('the hosted admin page has no #root');
}
createRoot(root).render(
  <StrictMode>
    <HostedApp
      ownTab={ownTab}
      config={readHostedConfig(PAYCORE_API_BASE, PAYCORE_OPERATOR)}
      createApi={(signer, apiBase) => createHostedApi({ base: apiBase, signer })}
      leave={() => window.location.replace(`${window.location.origin}/hosted/`)}
    />
  </StrictMode>,
);
