export function CopyIcon({ copied = false }: { copied?: boolean }) {
  return (
    <svg
      class="receipt-copy-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      aria-hidden="true"
    >
      {copied ? (
        <path d="m3 8 3.3 3.3L13 4.5" stroke-linecap="round" stroke-linejoin="round" />
      ) : (
        <>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
        </>
      )}
    </svg>
  );
}
