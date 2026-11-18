import type { ReactNode } from 'react';
import { WIDGET_TEXT } from '../widget-text';
import { AskrMark } from './AskrMark';
import { WidgetIcon } from './WidgetIcon';
import { Wordmark } from './Wordmark';

interface Props {
  /** The assistant's name, as the store set it. */
  name: string;
  children: ReactNode;
  chips?: readonly string[];
  className?: string;
}

/** The widget's open panel, drawn as the widget draws it; the conversation goes in `children`. */
export function WidgetPanel({ name, children, chips = [], className = '' }: Props) {
  return (
    <div className={`wgt wgt-panel ${className}`}>
      <div className="wgt-header">
        <div className="min-w-0 flex-1">
          <div className="font-semibold tracking-[-0.01em]">{name}</div>
          <div className="wgt-muted text-12">{WIDGET_TEXT.aiLabel}</div>
        </div>
        <WidgetIcon name="close" className="wgt-muted size-16" />
      </div>
      <div className="wgt-log">{children}</div>
      {chips.length > 0 && (
        <div className="wgt-chips">
          {chips.map((chip) => (
            <span key={chip} className="wgt-chip">
              {chip}
            </span>
          ))}
        </div>
      )}
      <div className="wgt-composer">
        <span className="wgt-input">{WIDGET_TEXT.placeholder}</span>
        <span className="wgt-send">{WIDGET_TEXT.send}</span>
      </div>
      <div className="wgt-muted flex items-center justify-center gap-5 px-16 pb-10 text-[11.5px]">
        {WIDGET_TEXT.poweredBy}
        <AskrMark className="-mr-2 size-19" />
        <Wordmark className="h-12 w-auto text-[#121316]" />
      </div>
    </div>
  );
}
