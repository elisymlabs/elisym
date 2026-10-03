import type { OfferWarning } from '@elisym/commerce';
import { WARNING_DETAILS, WARNINGS } from './text';

interface Props {
  /** Warnings to confirm, then notices: every one is always listed. */
  warnings: readonly OfferWarning[];
  /** The confirmation checkbox, when one is needed. */
  confirm: { checked: boolean; onChange(checked: boolean): void } | undefined;
}

export function Warnings({ warnings, confirm }: Props) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div class="warnings">
      <ul>
        {warnings.map((warning) => (
          <li key={warning}>{WARNINGS[warning]}</li>
        ))}
      </ul>
      <details>
        <summary>Why this matters</summary>
        {warnings.map((warning) => (
          <p key={warning}>{WARNING_DETAILS[warning]}</p>
        ))}
      </details>
      {confirm === undefined ? null : (
        <label class="confirm">
          <input
            type="checkbox"
            checked={confirm.checked}
            onChange={(event) => confirm.onChange(event.currentTarget.checked)}
          />
          <span>I have read the warnings above and still want to pay.</span>
        </label>
      )}
    </div>
  );
}
