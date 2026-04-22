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
    <div className="fixed inset-0 bg-black/40 z-[9999] flex items-center justify-center backdrop-blur-sm">
      <div className="bg-surface border border-border rounded-[18px] w-[480px] max-w-[95vw] p-8">
        <h2 className="text-xl font-bold mb-4">Terms of Service</h2>

        <div className="text-sm text-text-2 leading-relaxed space-y-3 mb-6">
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
              className="text-accent hover:underline font-medium"
            >
              Read full Terms of Service
            </a>
          </p>
        </div>

        <label className="flex items-start gap-3 cursor-pointer mb-6 select-none">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-accent cursor-pointer"
          />
          <span className="text-sm text-text">I have read and agree to the Terms of Service</span>
        </label>

        <button
          onClick={handleAccept}
          disabled={!checked}
          className="w-full py-3 rounded-[10px] border-none bg-accent text-white text-sm font-semibold cursor-pointer hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
