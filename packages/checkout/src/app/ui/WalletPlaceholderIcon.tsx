/** A quiet, rounded wallet outline for the unselected wallet field. */
export function WalletPlaceholderIcon() {
  return (
    <svg
      class="wallet-placeholder-symbol"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 7V5.75A1.75 1.75 0 0 1 7.75 4h8.5A1.75 1.75 0 0 1 18 5.75V7" />
      <path d="M20 10.5v-1A2.5 2.5 0 0 0 17.5 7h-11A3 3 0 0 0 3.5 10v7.5A2.5 2.5 0 0 0 6 20h11.5a2.5 2.5 0 0 0 2.5-2.5v-1" />
      <path d="M20 10.5h-3.5a3 3 0 0 0 0 6H20a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1Z" />
      <circle cx="17" cy="13.5" r=".8" fill="currentColor" stroke="none" />
    </svg>
  );
}
