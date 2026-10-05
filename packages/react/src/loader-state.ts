/**
 * Whether the v3 loader's modal is open now, read from its open shadow root
 * (v3 is frozen, so its markup is fixed): the `dialog` part shown with
 * `showModal`, or, where `showModal` is missing, the overlay around it shown.
 * For an element the loader has not built a modal for yet, false.
 *
 * Attributes only, no `HTMLDialogElement`: the fallback path runs exactly where
 * that global is missing (older Safari and Firefox), and attributes read the
 * same across realms. `showModal` sets `open`; `hidden` reflects its attribute.
 */
interface AttributeNode {
  hasAttribute(name: string): boolean;
}

interface ModalNode extends AttributeNode {
  readonly parentElement: AttributeNode | null;
}

/** What is read of the element: an element of any realm fits. */
interface ShadowHost {
  readonly shadowRoot: { querySelector(selectors: string): ModalNode | null } | null;
}

export function loaderModalOpen(element: ShadowHost): boolean {
  const dialog = element.shadowRoot?.querySelector('dialog[part="dialog"]');
  if (dialog === null || dialog === undefined) {
    return false;
  }
  if (dialog.hasAttribute('open')) {
    return true;
  }
  // The dialog's parent is the shadow root (no parent element) or the overlay.
  const overlay = dialog.parentElement;
  return overlay !== null && !overlay.hasAttribute('hidden');
}
