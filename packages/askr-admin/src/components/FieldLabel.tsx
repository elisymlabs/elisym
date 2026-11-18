import type { Help } from '../lib/help';
import { InfoTip } from './InfoTip';

interface Props {
  htmlFor: string;
  label: string;
  info?: Help;
}

/** A field's label, with an info button beside it when the field has help. */
export function FieldLabel({ htmlFor, label, info }: Props) {
  return (
    // Inline, not flex: a label that wraps keeps the button right after its last word.
    <span className="field-label">
      <label htmlFor={htmlFor}>{label}</label>
      {info === undefined ? null : (
        <span className="ml-6 inline-flex align-[-2px]">
          <InfoTip help={info} about={label} />
        </span>
      )}
    </span>
  );
}
