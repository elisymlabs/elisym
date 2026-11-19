import type { ReactNode, Ref } from 'react';
import { WIDGET_TEXT } from '../widget-text';
import { AskrMark } from './AskrMark';
import { WidgetIcon } from './WidgetIcon';
import { Wordmark } from './Wordmark';

interface Props {
  /** The assistant's name, as the store set it. */
  name: string;
  children: ReactNode;
  /** The status line under the conversation, as the widget shows it while it waits. */
  status?: ReactNode;
  chips?: readonly string[];
  /** The conversation's scroll box, for keeping the newest message in view. */
  logRef?: Ref<HTMLDivElement>;
  className?: string;
}

/*
 * The panel is always a drawing: whoever shows it says what it shows (a figure's label), so the
 * panel itself is hidden from assistive technology, chrome and all.
 */

/** The widget's open panel, drawn as the widget draws it; the conversation goes in `children`. */
export function WidgetPanel({ name, children, status, chips = [], logRef, className = '' }: Props) {
  return (
    <div aria-hidden="true" className={`wgt wgt-panel wgt-live ${className}`}>
      <div className="wgt-header">
        <div className="min-w-0 flex-1">
          <div className="font-semibold tracking-[-0.01em]">{name}</div>
          <div className="wgt-muted text-12">{WIDGET_TEXT.aiLabel}</div>
        </div>
        <span data-demo className="flex">
          <WidgetIcon name="close" className="wgt-muted size-16" />
        </span>
      </div>
      <div ref={logRef} className="wgt-log">
        {children}
      </div>
      {/* The status line and the chips row are always there, as in the widget: nothing jumps. */}
      <div className="wgt-status">{status}</div>
      <div className="wgt-chips">
        {chips.map((chip) => (
          <span key={chip} data-demo className="wgt-chip">
            {chip}
          </span>
        ))}
      </div>
      <div className="wgt-composer">
        <span data-demo className="wgt-input">
          {WIDGET_TEXT.placeholder}
        </span>
        <span data-demo className="wgt-send">
          {WIDGET_TEXT.send}
        </span>
      </div>
      <div className="wgt-muted flex items-center justify-center gap-5 px-16 pb-10 text-[11.5px]">
        {WIDGET_TEXT.poweredBy}
        <AskrMark className="-mr-2 size-19" />
        <Wordmark className="h-12 w-auto text-[#121316]" />
      </div>
    </div>
  );
}
