import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createSessionDeps } from './lib/deps';
import { takePlanIntent } from './lib/plan-intent';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('the admin page has no #root');
}
// Read once, before React renders (StrictMode runs initializers twice).
const intent = takePlanIntent(globalThis.location, globalThis.history);
createRoot(root).render(
  <StrictMode>
    <App
      createDeps={createSessionDeps}
      {...(intent === undefined ? {} : { initialIntent: intent })}
    />
  </StrictMode>,
);
