/** Shown instead of the key field when another page framed or opened this one. */
export function OwnTabNotice() {
  return (
    <main className="mx-auto max-w-560 px-16 py-64">
      <h1 className="text-24 font-semibold">Open this page in its own tab</h1>
      <p className="text-text-2 mt-12">
        This page was opened by another page, or inside one. It asks for your store key only in a
        tab of its own: type its address into a new tab.
      </p>
    </main>
  );
}
