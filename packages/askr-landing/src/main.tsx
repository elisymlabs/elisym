import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('the landing page has no #root');
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
