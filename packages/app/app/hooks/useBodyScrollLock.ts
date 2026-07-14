import { useLayoutEffect } from 'react';

export function useBodyScrollLock(locked: boolean) {
  // Layout effect, not passive: the wallet-adapter modal snapshots
  // `getComputedStyle(body).overflow` in ITS layout effect on mount and
  // restores that value when it closes. When a locking dialog unmounts in the
  // same commit that opens the wallet modal, a passive cleanup would run
  // AFTER the snapshot - the modal would capture 'hidden' and "restore" a
  // permanent scroll lock. Layout cleanups of deleted components run in the
  // mutation phase, before the new tree's layout effects.
  useLayoutEffect(() => {
    if (!locked) {
      return;
    }
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, [locked]);
}
