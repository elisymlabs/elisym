import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { useBodyScrollLock } from '~/hooks/useBodyScrollLock';
import { cn } from '~/lib/cn';
import { ProductAvatar } from './ProductAvatar';
import type { Artifact } from './types';

interface Props {
  artifact: Artifact;
  onClose: () => void;
  isRated: boolean;
  thanksMounted: boolean;
  thanksVisible: boolean;
  onRate: (positive: boolean) => void;
}

async function copyResult(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Result copied');
  } catch {
    toast.error('Copy failed');
  }
}

export function ArtifactModal({
  artifact,
  onClose,
  isRated,
  thanksMounted,
  thanksVisible,
  onRate,
}: Props) {
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const date = new Date(artifact.createdAt);
  const dateStr = date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const rated = isRated;
  const showFeedbackRow = artifact.capability && !(rated && !thanksMounted);
  const feedbackCollapsed = rated && !thanksVisible;

  return createPortal(
    <div
      className="backdrop-in fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 p-8 backdrop-blur-md sm:p-16"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal-in relative flex max-h-[92vh] w-760 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-20 bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.08)] sm:max-w-[95vw]">
        <div className="flex items-start gap-10 border-b border-black/6 px-16 pt-20 pr-48 pb-16 sm:gap-12 sm:px-32 sm:pt-28 sm:pr-64 sm:pb-20">
          <ProductAvatar name={artifact.cardName} size={40} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] leading-tight font-semibold sm:text-base">
              {artifact.cardName}
            </div>
            <div className="mt-2 text-xs text-text-2/80 tabular-nums">{dateStr}</div>
          </div>
          <button
            onClick={() => void copyResult(artifact.result)}
            className="inline-flex shrink-0 cursor-pointer items-center gap-6 rounded-12 border-0 bg-surface-2 px-10 py-8 text-[13px] font-medium text-text-2 transition-colors hover:bg-tag-bg hover:text-text sm:gap-8 sm:px-16 sm:py-10 sm:text-sm"
            title="Copy result"
          >
            <svg
              aria-hidden
              className="size-16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy
          </button>
          <button
            onClick={onClose}
            className="absolute top-8 right-8 z-10 flex size-36 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-text-2 transition-colors hover:text-text sm:top-12 sm:right-12"
            aria-label="Close"
          >
            <svg
              aria-hidden
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-16 pt-20 pb-24 sm:px-32 sm:pt-28 sm:pb-28">
          {artifact.prompt && (
            <div className="mb-16 w-full rounded-xl px-12 py-10 prompt-block sm:mb-20 sm:px-16 sm:py-12">
              <div className="mb-2 text-xs text-text-2">Prompt</div>
              <div className="text-sm break-words whitespace-pre-wrap text-text">
                {artifact.prompt}
              </div>
            </div>
          )}
          <div className="text-[14px] leading-[1.6] break-words whitespace-pre-wrap text-text sm:text-[15px] sm:leading-[1.65]">
            {artifact.result}
          </div>
        </div>
        {showFeedbackRow && (
          <div
            className={cn(
              'flex shrink-0 flex-wrap items-center gap-8 overflow-hidden bg-surface-2/40 px-16 pb-[max(env(safe-area-inset-bottom),0px)] transition-[opacity,max-height,padding] duration-[600ms] sm:h-70 sm:flex-nowrap sm:gap-12 sm:px-32',
              feedbackCollapsed
                ? 'max-h-0 py-0 opacity-0'
                : 'max-h-[200px] py-12 opacity-100 sm:max-h-70 sm:py-16',
            )}
          >
            {rated ? (
              thanksMounted && <p className="m-0 text-xs text-text-2">Thanks for your feedback!</p>
            ) : (
              <>
                <span className="text-xs text-text-2">How was this result?</span>
                <div className="flex items-center gap-8">
                  <button
                    onClick={() => onRate(true)}
                    className="cursor-pointer rounded-full border border-black/10 bg-surface px-12 py-6 text-[12px] font-medium transition-colors hover:bg-black/4"
                  >
                    👍 Good
                  </button>
                  <button
                    onClick={() => onRate(false)}
                    className="cursor-pointer rounded-full border border-black/10 bg-surface px-12 py-6 text-[12px] font-medium transition-colors hover:bg-black/4"
                  >
                    👎 Bad
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
