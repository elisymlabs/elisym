import { LIMITS } from '@elisym/sdk';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '~/lib/cn';

interface Props {
  onSend: (content: string) => Promise<void>;
}

export function MessageComposer({ onSend }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= LIMITS.MAX_MESSAGE_LENGTH && !sending;

  async function submit() {
    if (!canSend) {
      return;
    }
    setSending(true);
    try {
      await onSend(trimmed);
      setDraft('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex items-end gap-8 border-t border-black/5 p-12">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        rows={2}
        maxLength={LIMITS.MAX_MESSAGE_LENGTH}
        placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
        className="max-h-160 min-h-40 flex-1 resize-y rounded-12 border border-black/10 bg-surface px-12 py-8 text-sm text-text outline-none placeholder:text-text-2/60 focus:border-accent"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSend}
        className={cn(
          'shrink-0 btn-primary btn px-16 py-10 text-sm',
          !canSend && 'cursor-not-allowed opacity-50',
        )}
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}
