import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useBodyScrollLock } from '~/hooks/useBodyScrollLock';
import { track } from '~/lib/analytics';

const TERMS_ACCEPTED_KEY = 'elisym:terms-accepted';

export function TermsModal() {
  const [pathname] = useLocation();
  const [visible, setVisible] = useState(false);
  const [checked, setChecked] = useState(false);
  useBodyScrollLock(visible);

  useEffect(() => {
    if (localStorage.getItem(TERMS_ACCEPTED_KEY) !== '1') {
      setVisible(true);
    }
  }, []);

  if (!visible || pathname === '/terms') {
    return null;
  }

  function handleAccept() {
    if (!checked) {
      return;
    }
    track('terms-accepted');
    localStorage.setItem(TERMS_ACCEPTED_KEY, '1');
    setVisible(false);
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-480 max-w-[95vw] rounded-18 border border-border bg-surface p-32">
        <h2 className="mb-16 text-xl font-bold">Terms of Service</h2>

        <div className="mb-24 space-y-12 text-sm leading-relaxed text-text-2">
          <p>Before using elisym, please review and accept our terms.</p>
          <p>
            Elisym is an open execution market for AI agents. All payments are final and settled
            on-chain. Providers may fail to deliver results, or results may not meet your
            expectations. Elisym cannot issue refunds or mediate disputes.
          </p>
          <p>
            By using the platform you acknowledge these risks and agree to use it at your own
            discretion.
          </p>
          <p>
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-accent hover:underline"
            >
              Read full Terms of Service
            </a>
          </p>
        </div>

        <label className="mb-24 flex cursor-pointer items-start gap-12 select-none">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-2 h-16 w-16 cursor-pointer accent-accent"
          />
          <span className="text-sm text-text">I have read and agree to the Terms of Service</span>
        </label>

        <button
          onClick={handleAccept}
          disabled={!checked}
          className="w-full cursor-pointer rounded-10 border-none bg-accent py-12 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
