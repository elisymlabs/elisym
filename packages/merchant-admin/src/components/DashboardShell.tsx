import { type ReactNode, useEffect, useRef, useState } from 'react';
import { PRODUCT_NAME } from '../constants';
import { short } from '../lib/core';
import { CopyButton } from './CopyButton';
import { Icon, type IconName } from './Icon';
import { LogoMark } from './LogoMark';
import { PayCoreLogo } from './PayCoreLogo';
import { StatusLine } from './StatusLine';

/** Where the sidebar stops being a phone menu (Tailwind's `md`). */
const WIDE_LAYOUT = '(min-width: 768px)';

/** One page of the store: its place in the sidebar and what it shows. */
export interface ShellPage {
  id: string;
  label: string;
  icon: IconName;
  /** A count shown beside the label (orders, products). */
  count?: number;
  /** Why the page cannot open yet; set, the page stays shut. */
  locked?: string;
  content: ReactNode;
}

interface Props {
  /** The store's name, as its profile says it. */
  name: string | undefined;
  /** What stands for a store with no name yet. */
  unnamed: string;
  /** The key's public id, shown short and copied whole, with the copy button's words. */
  identity: { value: string; copyLabel: string };
  status: string;
  busy: boolean;
  /** Reads the store again; none, no Refresh (a store with nothing left to read). */
  onRefresh?: () => void;
  onSignOut: () => void;
  signOutLabel: string;
  pages: readonly ShellPage[];
  active: string;
  onSelect: (id: string) => void;
  /** Shown alone, with no pages to choose (a store that left: its handover, or its end). */
  alone?: ReactNode;
}

/**
 * The admin's frame: a sidebar of pages (a top bar with a menu on a phone) and
 * the open page beside it. Every page stays mounted, so filters and open rows
 * survive a switch; a switch moves focus to the new page's heading.
 */
export function DashboardShell({
  name,
  unnamed,
  identity,
  status,
  busy,
  onRefresh,
  onSignOut,
  signOutLabel,
  pages,
  active,
  onSelect,
  alone,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const shown = useRef(active);
  // The page was chosen from the phone menu: with no heading to take it, focus goes back to it.
  const fromMenu = useRef(false);

  // A page opened (not the first one shown): its heading takes the focus, from the top.
  useEffect(() => {
    if (shown.current === active) {
      return;
    }
    shown.current = active;
    window.scrollTo?.({ top: 0 });
    const heading = document.getElementById(`page-${active}`)?.querySelector('h1');
    if (heading !== null && heading !== undefined) {
      heading.focus();
    } else if (fromMenu.current) {
      menuButton.current?.focus();
    }
    fromMenu.current = false;
  }, [active]);

  const closeMenu = () => {
    setMenuOpen(false);
    menuButton.current?.focus();
  };

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    // Widened past the phone layout, the sidebar is the page's own: the menu, and the inert page, end.
    const wide = window.matchMedia?.(WIDE_LAYOUT);
    const onWide = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    wide?.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', onKey);
      wide?.removeEventListener('change', onWide);
    };
  }, [menuOpen]);

  const choose = (page: ShellPage) => {
    if (page.locked !== undefined) {
      return;
    }
    if (menuOpen) {
      setMenuOpen(false);
      if (page.id === active) {
        // Nothing opens: the focus, in the menu that closed, goes back to its button.
        menuButton.current?.focus();
        return;
      }
      fromMenu.current = true;
    }
    onSelect(page.id);
  };

  const storeName = name ?? unnamed;

  return (
    <div className="min-h-screen md:flex">
      <div className="border-line/60 bg-bg/80 sticky top-0 z-20 flex h-56 items-center gap-12 border-b px-16 backdrop-blur-md md:hidden">
        <LogoMark className="size-28 shrink-0" />
        <p className="text-15 min-w-0 flex-1 truncate font-semibold" title={storeName}>
          {storeName}
        </p>
        <button
          ref={menuButton}
          type="button"
          aria-expanded={menuOpen}
          aria-controls="store-sidebar"
          aria-label={menuOpen ? 'Close the menu' : 'Open the menu'}
          onClick={() => setMenuOpen((open) => !open)}
          className="rounded-10 border-line hover:bg-surface-2 grid size-40 place-items-center border"
        >
          <Icon name={menuOpen ? 'close' : 'menu'} className="size-20" />
        </button>
      </div>
      {menuOpen && (
        <div
          id="sidebar-backdrop"
          aria-hidden="true"
          onClick={closeMenu}
          className="bg-bg/70 fixed inset-0 z-30 backdrop-blur-sm md:hidden"
        />
      )}
      <aside
        id="store-sidebar"
        className={`bg-surface border-line z-40 w-240 shrink-0 flex-col gap-24 border-r px-16 py-20 md:sticky md:top-0 md:flex md:h-screen md:overflow-y-auto ${
          menuOpen ? 'fixed inset-y-0 left-0 flex overflow-y-auto' : 'hidden'
        }`}
      >
        <span className="flex items-center gap-10" title={PRODUCT_NAME}>
          <PayCoreLogo className="h-28 w-auto" />
        </span>
        <p id="store-name" className="text-15 truncate font-semibold" title={storeName}>
          {storeName}
        </p>
        <nav aria-label="Store" className="flex flex-col gap-2">
          {(alone === undefined ? pages : []).map((page) => {
            const current = page.id === active;
            const locked = page.locked !== undefined;
            return (
              <button
                key={page.id}
                id={`nav-${page.id}`}
                type="button"
                aria-current={current ? 'page' : undefined}
                aria-disabled={locked || undefined}
                aria-describedby={locked ? `nav-${page.id}-locked` : undefined}
                onClick={() => choose(page)}
                className={`rounded-10 text-14 flex items-center gap-10 px-10 py-8 text-left font-medium transition ${
                  current
                    ? 'bg-surface-2 text-text'
                    : 'text-text-2 hover:bg-surface-2 hover:text-text'
                } ${locked ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <Icon name={locked ? 'lock' : page.icon} className="size-16 shrink-0" />
                <span className="min-w-0 flex-1">
                  {page.label}
                  {locked && (
                    // Out of the button's name: read once, as its description.
                    <span
                      id={`nav-${page.id}-locked`}
                      aria-hidden="true"
                      className="text-12 text-text-3 block"
                    >
                      {page.locked}
                    </span>
                  )}
                </span>
                {page.count !== undefined && (
                  <span className="bg-bg text-11 text-text-2 rounded-full px-6 py-1">
                    {page.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="border-line mt-auto flex flex-col gap-10 border-t pt-16">
          <p className="text-12 text-text-3 flex h-18 items-center gap-2 font-mono">
            <span id="store-pubkey" title={identity.value}>
              {short(identity.value)}
            </span>
            <CopyButton text={identity.value} label={identity.copyLabel} />
          </p>
          {onRefresh === undefined ? null : (
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className="rounded-10 border-line bg-surface text-14 hover:bg-surface-2 flex items-center gap-6 border px-12 py-8 font-medium disabled:opacity-50"
            >
              <Icon name="refresh" className={`size-16 ${busy ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          )}
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-10 bg-ink text-14 text-ink-text flex items-center gap-6 px-12 py-8 font-medium hover:opacity-90"
          >
            <Icon name="logout" className="size-16" />
            {signOutLabel}
          </button>
        </div>
      </aside>
      {/* Under the open phone menu, the page is out of reach. */}
      <main className="min-w-0 flex-1" inert={menuOpen || undefined}>
        <div className="mx-auto flex w-full max-w-880 flex-col gap-20 px-16 py-24 sm:px-32 sm:py-40">
          <StatusLine status={status} busy={busy} />
          {alone ??
            pages.map((page) => (
              <div key={page.id} id={`page-${page.id}`} hidden={page.id !== active}>
                {page.content}
              </div>
            ))}
        </div>
      </main>
    </div>
  );
}
