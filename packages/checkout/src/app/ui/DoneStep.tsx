import type { View } from '../session';
import { CopyText } from './CopyText';
import { CHECK_GLYPH } from './glyphs';
import { StepHeading } from './StepHeading';

interface Props {
  view: Extract<View, { kind: 'delivered' }>;
  onBuyAgain(): void;
  /** In a modal only: close it. */
  onDone?: () => void;
}

/** The link's host, so the buyer sees where "Open" goes. */
function hostOf(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return '';
  }
}

export function DoneStep({ view, onBuyAgain, onDone }: Props) {
  return (
    <div class="step done" data-step="done">
      <img class="mark" src={CHECK_GLYPH} alt="" aria-hidden="true" />
      <StepHeading>Delivered</StepHeading>
      {view.link === undefined ? (
        <CopyText text={view.text} />
      ) : (
        <div class="open">
          <a class="button primary" href={view.link} target="_blank" rel="noopener noreferrer">
            Open
          </a>
          <p class="note">{hostOf(view.link)}</p>
        </div>
      )}
      {onDone === undefined ? null : (
        <button type="button" class="secondary" onClick={onDone}>
          Done
        </button>
      )}
      <button type="button" class="secondary" onClick={onBuyAgain}>
        Buy again
      </button>
    </div>
  );
}
