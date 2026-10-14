import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createSessionDeps } from './lib/deps';
import { claimWindow } from './lib/own-tab';

const ownTab = claimWindow(window);
const root = document.getElementById('root');
if (root === null) {
  throw new Error('the admin page has no #root');
}
createRoot(root).render(
  <StrictMode>
    <App
      ownTab={ownTab}
      createDeps={createSessionDeps}
      leave={() => window.location.replace(`${window.location.origin}/`)}
    />
  </StrictMode>,
);
