import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useBodyScrollLock } from '~/hooks/useBodyScrollLock';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';

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
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-12 backdrop-blur-sm sm:p-16">
      <div className="w-480 max-w-full rounded-3xl border border-border bg-surface p-20 sm:p-32">
        <h2 className="mb-12 text-lg font-bold sm:mb-16 sm:text-xl">Terms of Service</h2>

        <div className="mb-20 space-y-12 text-sm leading-relaxed text-text-2 sm:mb-24">
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
        </div>

        <label className="group mb-20 flex cursor-pointer items-start gap-8 select-none sm:mb-24">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="peer sr-only"
          />
          <span
            className={cn(
              'mt-1 grid size-18 shrink-0 place-items-center rounded-6 border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40',
              checked
                ? 'border-surface-dark bg-surface-dark'
                : 'border-border bg-surface-2 group-hover:border-text-2/40',
            )}
          >
            {checked && (
              <svg aria-hidden className="size-12 text-white" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3.5 8.5 L6.5 11.5 L12.5 5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <span className="text-sm text-text">
            I have read and agree to the{' '}
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-medium text-accent underline"
            >
              Terms of Service
            </a>
          </span>
        </label>

        <button
          onClick={handleAccept}
          disabled={!checked}
          className="inline-flex h-44 w-full cursor-pointer items-center justify-center rounded-xl border-none bg-surface-dark text-sm font-semibold text-white transition-colors hover:bg-[#2a2a2e] disabled:cursor-not-allowed disabled:opacity-25"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
