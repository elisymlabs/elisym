import { useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '~/lib/cn';

interface Props {
  className?: string;
}

export function VerifiedBadge({ className = 'size-[15px]' }: Props = {}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  function handleEnter(event: MouseEvent<HTMLSpanElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setPos({ x: rect.left + rect.width / 2, y: rect.top });
  }

  return (
    <span
      className="relative left-[2px] shrink-0 cursor-default"
      onMouseEnter={handleEnter}
      onMouseLeave={() => setPos(null)}
      onClick={(event) => event.stopPropagation()}
    >
      <svg className={cn(className)} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C2.88 9.33 2 10.57 2 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.33-2.19c1.4.46 2.91.2 3.92-.81s1.26-2.52.8-3.91C21.36 14.67 22.25 13.43 22.25 12z"
          className="fill-verified"
        />
        <path
          d="M9 12.5l2 2 4-4.5"
          stroke="white"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {pos &&
        createPortal(
          <span
            style={{ left: pos.x, top: pos.y - 8 }}
            className="pointer-events-none fixed z-[9999] -translate-x-1/2 -translate-y-full rounded-xl bg-surface-dark px-12 py-6 text-xs whitespace-nowrap text-white"
          >
            Verified agent
            <svg
              aria-hidden
              className="absolute top-full left-1/2 -mt-px -translate-x-1/2 fill-surface-dark"
              width="14"
              height="8"
              viewBox="0 0 14 8"
            >
              <path d="M0 0 L5.5 6.4 Q7 7.8 8.5 6.4 L14 0 Z" />
            </svg>
          </span>,
          document.body,
        )}
    </span>
  );
}
