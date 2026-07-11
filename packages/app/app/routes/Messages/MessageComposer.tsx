import { LIMITS } from '@elisym/sdk';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '~/lib/cn';

interface Props {
  onSend: (content: string) => Promise<void>;
}

const MAX_TEXTAREA_HEIGHT_PX = 160;
/** Show the remaining-characters counter once 90% of the limit is used. */
const COUNTER_THRESHOLD = Math.floor(LIMITS.MAX_MESSAGE_LENGTH * 0.9);

export function MessageComposer({ onSend }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= LIMITS.MAX_MESSAGE_LENGTH && !sending;
  const remaining = LIMITS.MAX_MESSAGE_LENGTH - draft.length;

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }

  function resetHeight() {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
    }
  }

  async function submit() {
    if (!canSend) {
      return;
    }
    const content = trimmed;
    // Clear optimistically: the live subscription can surface the message in
    // the thread before every relay has confirmed the publish, and the field
    // must not still hold the text at that point.
    setDraft('');
    resetHeight();
    setSending(true);
    try {
      await onSend(content);
    } catch (error) {
      // Restore the draft so a failed send never loses the text.
      setDraft(content);
      requestAnimationFrame(autoGrow);
      toast.error(error instanceof Error ? error.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border-t border-black/5 p-12">
      <div className="flex items-end gap-6 rounded-20 border border-border bg-surface p-6 transition-colors focus-within:border-accent">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            autoGrow();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={1}
          maxLength={LIMITS.MAX_MESSAGE_LENGTH}
          placeholder="Write a message…"
          aria-label="Message"
          className="min-h-28 flex-1 resize-none border-0 bg-transparent px-10 py-6 text-sm text-text outline-none placeholder:text-text-2/60"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSend}
          aria-label="Send message"
          title="Send (Enter)"
          className={cn(
            'group inline-flex size-32 shrink-0 items-center justify-center rounded-full border-0 transition-all duration-200',
            canSend
              ? 'scale-100 cursor-pointer bg-accent text-white shadow-[0_2px_6px_rgba(26,26,46,0.35)] hover:bg-accent-hover active:scale-90'
              : 'scale-90 cursor-not-allowed bg-surface-2 text-text-2/60',
          )}
        >
          {sending ? (
            <svg aria-hidden className="size-14 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                strokeOpacity="0.3"
                strokeWidth="3"
              />
              <path
                d="M21 12a9 9 0 0 0-9-9"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg
              aria-hidden
              // The plane glyph leans up-right; a 1px down-left shift centers it
              // optically. On hover it tilts toward its flight path.
              className={cn(
                'size-14 -translate-x-1 translate-y-1 transition-transform duration-200',
                canSend && 'group-hover:-rotate-12',
              )}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m22 2-7 20-4-9-9-4z" />
              <path d="M22 2 11 13" />
            </svg>
          )}
        </button>
      </div>
      {draft.length >= COUNTER_THRESHOLD && (
        <p
          className={cn(
            'mt-4 text-right text-[10px]',
            remaining === 0 ? 'text-error' : 'text-text-2',
          )}
        >
          {remaining} characters left
        </p>
      )}
    </div>
  );
}
