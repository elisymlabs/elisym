import { useEffect } from 'react';

/** What stops the late scroll: the visitor has started scrolling on their own. */
const VISITOR_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/** Navigations where the browser puts back the scroll position the visitor left the page at. */
const RESTORED_NAVIGATIONS: ReadonlySet<string> = new Set(['reload', 'back_forward']);

function isRestoredNavigation(): boolean {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    return false;
  }
  const [entry] = performance.getEntriesByType('navigation');
  return entry !== undefined && 'type' in entry && RESTORED_NAVIGATIONS.has(String(entry.type));
}

function hashTarget(): Element | null {
  const id = window.location.hash.slice(1);
  if (id === '') {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return null;
  }
  return document.getElementById(decoded);
}

/**
 * The page renders in the browser, so when it opens at an address with a hash (`/#pricing`) the
 * browser looks for the section before it exists and stays at the top. This scrolls to it once
 * the page has rendered, and once more when images and fonts have loaded and moved it, unless the
 * visitor has scrolled meanwhile. A reload or Back keeps the position the browser restores.
 */
export function useHashScroll(): void {
  useEffect(() => {
    if (isRestoredNavigation() || hashTarget() === null) {
      return undefined;
    }
    let visitorScrolled = false;
    const onVisitorScroll = () => {
      visitorScrolled = true;
    };
    const scrollToTarget = () => {
      if (!visitorScrolled) {
        hashTarget()?.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    };
    for (const name of VISITOR_SCROLL_EVENTS) {
      window.addEventListener(name, onVisitorScroll, { passive: true, once: true });
    }
    const frame = window.requestAnimationFrame(scrollToTarget);
    const loaded = document.readyState === 'complete';
    if (!loaded) {
      window.addEventListener('load', scrollToTarget, { once: true });
    }
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('load', scrollToTarget);
      for (const name of VISITOR_SCROLL_EVENTS) {
        window.removeEventListener(name, onVisitorScroll);
      }
    };
  }, []);
}
