interface Props {
  /** The buyer's value, kept across steps. */
  value: string;
  onInput(value: string): void;
}

/** Always the same field, empty or not: a returning buyer's open order shows nothing different. */
export function EmailField({ value, onInput }: Props) {
  return (
    <label class="field">
      <span>Email for the store (optional)</span>
      <input
        type="email"
        autoComplete="email"
        value={value}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
    </label>
  );
}
