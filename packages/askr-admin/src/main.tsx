import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createSessionDeps } from './lib/deps';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('the admin page has no #root');
}
createRoot(root).render(
  <StrictMode>
    <App createDeps={createSessionDeps} />
  </StrictMode>,
);
