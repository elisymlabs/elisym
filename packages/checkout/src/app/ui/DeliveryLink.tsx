interface Props {
  /** An `https:` delivery link (`deliveryLink`). */
  link: string;
}

/** The link's host, so the buyer sees where "Open" goes. */
function hostOf(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return '';
  }
}

/** A delivery opened from a button, its host named under it. */
export function DeliveryLink({ link }: Props) {
  return (
    <div class="open">
      <a class="button primary" href={link} target="_blank" rel="noopener noreferrer">
        Open
      </a>
      <p class="note">{hostOf(link)}</p>
    </div>
  );
}
