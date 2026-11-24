interface Props {
  /** The relays this server allows. */
  allowed: readonly string[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
}

/** Where buyers send orders: one or more of the relays the server allows. */
export function InboxRelays({ allowed, selected, onChange }: Props) {
  const toggle = (relay: string) => {
    const next = selected.includes(relay)
      ? selected.filter((item) => item !== relay)
      : allowed.filter((item) => item === relay || selected.includes(item));
    onChange(next);
  };
  return (
    <fieldset className="flex flex-col gap-8">
      <legend className="text-14 mb-4 font-medium">Inbox relays</legend>
      <p className="text-13 text-text-2">
        Buyers send their orders to these relays. Keep one at least.
      </p>
      {allowed.map((relay, index) => (
        <label key={relay} className="text-14 flex items-center gap-8">
          <input
            type="checkbox"
            id={`inbox-relay-${index}`}
            checked={selected.includes(relay)}
            onChange={() => toggle(relay)}
          />
          <span className="font-mono break-all">{relay}</span>
        </label>
      ))}
    </fieldset>
  );
}
