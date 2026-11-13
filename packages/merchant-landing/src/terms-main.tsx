import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TermsPage } from './components/TermsPage';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('the terms page has no #root');
}
createRoot(root).render(
  <StrictMode>
    <TermsPage />
  </StrictMode>,
);
