import './app.css';
import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

/** Render a page of this site into its `#root`. */
export function mount(page: ReactElement): void {
  const root = document.getElementById('root');
  if (root === null) {
    throw new Error('the page has no #root');
  }
  createRoot(root).render(<StrictMode>{page}</StrictMode>);
}
