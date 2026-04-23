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
      className="backdrop-in fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 p-16 backdrop-blur-md"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal-in relative flex max-h-[90vh] w-760 max-w-[95vw] flex-col overflow-hidden rounded-20 bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.08)]">
        <div className="flex items-start gap-12 border-b border-black/6 px-32 pt-28 pr-64 pb-20">
          <ProductAvatar name={artifact.cardName} size={40} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base leading-tight font-semibold">
              {artifact.cardName}
            </div>
            <div className="mt-2 text-xs text-text-2/80 tabular-nums">{dateStr}</div>
          </div>
          <button
            onClick={() => void copyResult(artifact.result)}
            className="inline-flex shrink-0 cursor-pointer items-center gap-8 rounded-12 border-0 bg-surface-2 px-16 py-10 text-sm font-medium text-text-2 transition-colors hover:bg-tag-bg hover:text-text"
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
            className="absolute top-12 right-12 z-10 flex size-36 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-text-2 transition-colors hover:text-text"
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
        <div className="overflow-y-auto px-32 py-28">
          {artifact.prompt && (
            <div className="mb-20 w-full rounded-xl px-16 py-12 prompt-block">
              <div className="mb-6 text-xs text-text-2">Prompt</div>
              <div className="text-sm break-words whitespace-pre-wrap text-text">
                {artifact.prompt}
              </div>
            </div>
          )}
          <div className="text-[15px] leading-[1.65] break-words whitespace-pre-wrap text-text">
            {artifact.result}
          </div>
        </div>
        {showFeedbackRow && (
          <div
            className={cn(
              'flex h-70 items-center gap-12 overflow-hidden bg-surface-2/40 px-32 transition-[opacity,max-height,padding] duration-[600ms]',
              feedbackCollapsed ? 'max-h-0 py-0 opacity-0' : 'max-h-70 py-16 opacity-100',
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
