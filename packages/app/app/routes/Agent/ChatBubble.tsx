import type { ReactNode } from 'react';
import { cn } from '~/lib/cn';

interface Props {
  side: 'user' | 'assistant';
  /** Muted styling for pending/failed status bubbles. */
  tone?: 'normal' | 'status' | 'failed';
  children: ReactNode;
  /** Rendered under the bubble, on its side (timestamps, markers, actions). */
  footer?: ReactNode;
  onClick?: () => void;
}

/**
 * One chat bubble: user prompts on the right (dark), assistant results on the
 * left (borrowing the messenger's thread visuals). `onClick` marks the bubble
 * expandable (long results open the detail modal - clamped previews only,
 * never full-height bubbles).
 */
export function ChatBubble({ side, tone = 'normal', children, footer, onClick }: Props) {
  const isUser = side === 'user';

  let bubble: ReactNode;
  if (onClick) {
    bubble = (
      <button
        type="button"
        onClick={onClick}
        title="Open the full result"
        className={cn(
          'group relative max-w-[85%] cursor-pointer rounded-16 border-0 px-12 py-8 text-left font-[inherit] text-sm transition-opacity hover:opacity-90 sm:max-w-[70%]',
          isUser ? 'bg-surface-dark text-white' : 'bg-surface-2 text-text',
        )}
      >
        {children}
        {/* Hover affordance: the expand badge signals "opens in a popup". */}
        <span
          aria-hidden
          className="pointer-events-none absolute -top-6 -right-6 flex size-20 items-center justify-center rounded-full border border-black/10 bg-surface text-text-2 opacity-0 shadow-tooltip transition-opacity group-hover:opacity-100"
        >
          <svg
            className="size-10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </span>
      </button>
    );
  } else {
    bubble = (
      <div
        className={cn(
          'max-w-[85%] rounded-16 px-12 py-8 text-sm sm:max-w-[70%]',
          isUser ? 'bg-surface-dark text-white' : 'bg-surface-2 text-text',
          tone === 'status' && 'bg-surface-2/60 text-text-2',
          tone === 'failed' && 'border border-red-200 bg-red-50 text-red-600',
        )}
      >
        {children}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', isUser ? 'items-end' : 'items-start')}>
      {bubble}
      {footer}
    </div>
  );
}
