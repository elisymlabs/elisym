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
    <span className="field-label flex items-center gap-6">
      <label htmlFor={htmlFor}>{label}</label>
      {info === undefined ? null : <InfoTip help={info} about={label} />}
    </span>
  );
}
