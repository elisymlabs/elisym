import type { View } from '../session';

interface Props {
  /** The buyer's value, kept across steps. */
  value: string;
  onInput(value: string): void;
  /** The open order this pay press continues: its email already went with it. */
  continuing: Extract<View, { kind: 'offer' }>['continuing'];
}

export function EmailField({ value, onInput, continuing }: Props) {
  if (continuing === 'created') {
    return <p class="note">Your earlier order is being sent; an email, if given, goes with it.</p>;
  }
  if (continuing === 'ordered') {
    return (
      <p class="note">Your earlier order is still open; an email, if given, was sent with it.</p>
    );
  }
  return (
    <label class="field">
      <span>Email for the delivery (optional)</span>
      <input
        type="email"
        autoComplete="email"
        value={value}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
    </label>
  );
}
