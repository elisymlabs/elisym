import { WIDGET_TEXT } from '../widget-text';
import { LiveMark } from './LiveMark';

interface Props {
  className?: string;
}

/** The widget's closed state: the mark, "Ask AI" and what it does, in the page's corner. */
export function WidgetLauncher({ className = '' }: Props) {
  return (
    <span className={`wgt wgt-launcher ${className}`}>
      <LiveMark className="-mt-2 size-30 flex-none" />
      <span className="flex flex-col gap-1 text-left">
        <span className="text-14 leading-[1.2] font-bold tracking-[-0.01em]">
          {WIDGET_TEXT.launcher}
        </span>
        <span className="wgt-muted text-[11.5px] leading-[1.2]">{WIDGET_TEXT.launcherHint}</span>
      </span>
    </span>
  );
}
