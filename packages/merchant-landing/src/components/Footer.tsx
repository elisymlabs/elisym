import { DOCS, GITHUB_URL, X_URL } from '../constants';

export function Footer() {
  return (
    <footer className="border-line border-t">
      <div className="text-14 text-text-2 mx-auto flex max-w-1120 flex-wrap items-center justify-between gap-12 px-16 py-24">
        <span>elisym labs</span>
        <nav className="flex gap-16">
          <a href={DOCS.quickstart} className="hover:text-text">
            Docs
          </a>
          <a href={GITHUB_URL} rel="noopener noreferrer" className="hover:text-text">
            GitHub
          </a>
          <a href={X_URL} rel="noopener noreferrer" className="hover:text-text">
            X
          </a>
        </nav>
      </div>
    </footer>
  );
}
