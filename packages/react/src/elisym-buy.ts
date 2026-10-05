import { createElement, useEffect, useRef, type ReactElement } from 'react';
import { type ElementOptions, elementAttributes } from './attributes';
import { ensureLoader, warnIfOlderLoader, whenLoaderDefined } from './loader';
import { loaderModalOpen } from './loader-state';
import { type CheckoutState, isCheckoutState } from './states';

export interface ElisymBuyProps extends ElementOptions {
  /** The modal opened. */
  onOpen?: () => void;
  /** The modal closed (also when the element was removed while it was open). */
  onClose?: () => void;
  /** The purchase moved on. A state name only: never unlock or credit anything on it. */
  onStatus?: (state: CheckoutState) => void;
  /**
   * The store delivered (`completed`). For your UI only, such as a thank-you
   * note: a buyer can fake anything the page hears. Credit an account only from
   * your node's signed webhook.
   */
  onPaid?: () => void;
}

type Handlers = Pick<ElisymBuyProps, 'onOpen' | 'onClose' | 'onStatus' | 'onPaid'>;

function stateOf(event: Event): CheckoutState | undefined {
  if (!(event instanceof CustomEvent)) {
    return undefined;
  }
  const detail: unknown = event.detail;
  if (detail === null || typeof detail !== 'object' || !('state' in detail)) {
    return undefined;
  }
  return isCheckoutState(detail.state) ? detail.state : undefined;
}

function closedElement(event: Event): unknown {
  if (!(event instanceof CustomEvent)) {
    return undefined;
  }
  const detail: unknown = event.detail;
  if (detail === null || typeof detail !== 'object' || !('element' in detail)) {
    return undefined;
  }
  return detail.element;
}

/**
 * `<elisym-buy>`, the elisym checkout, on the pinned v3 loader. Server
 * rendering writes the element only; the loader's script is added in the
 * browser, once per document.
 */
export function ElisymBuy(props: ElisymBuyProps): ReactElement {
  const { onOpen, onClose, onStatus, onPaid, ...options } = props;
  const elementRef = useRef<HTMLElement>(null);
  const handlersRef = useRef<Handlers>({ onOpen, onClose, onStatus, onPaid });
  const carriesRef =
    (options.customerRef !== undefined && options.customerRef !== '') ||
    options.requireCustomerRef === true;

  useEffect(() => {
    handlersRef.current = { onOpen, onClose, onStatus, onPaid };
  });

  useEffect(() => {
    ensureLoader(document);
  }, []);

  useEffect(() => {
    if (!carriesRef) {
      return undefined;
    }
    let active = true;
    warnIfOlderLoader(document);
    void whenLoaderDefined(document)?.then(() => {
      if (active) {
        warnIfOlderLoader(document);
      }
    });
    return () => {
      active = false;
    };
  }, [carriesRef]);

  useEffect(() => {
    const element = elementRef.current;
    if (element === null) {
      return undefined;
    }
    // The loader fires one `elisym-open` per opening, on the element, and closes
    // only what is open: so one close per open, however many targets it reaches.
    // Subscribed while the modal is already open (hidden and shown again, a
    // loader that ran before hydration): its close still counts.
    let open = loaderModalOpen(element);
    // On the element only, where the loader fires it: heard once per opening.
    const handleOpen = (): void => {
      open = true;
      handlersRef.current.onOpen?.();
    };
    const handleStatus = (event: Event): void => {
      const state = stateOf(event);
      if (state === undefined) {
        return;
      }
      handlersRef.current.onStatus?.(state);
      if (state === 'completed') {
        handlersRef.current.onPaid?.();
      }
    };
    // A connected element's close bubbles to its root (the document, or the
    // shadow root it sits in, which it does not leave); for an element removed
    // while open, the loader also fires a second close on `document`. Both are
    // heard; the first close of an opening counts.
    const closeTargets = new Set<EventTarget>([element.getRootNode(), document]);
    const handleClose = (event: Event): void => {
      if (!open || closedElement(event) !== element) {
        return;
      }
      open = false;
      handlersRef.current.onClose?.();
    };
    element.addEventListener('elisym-open', handleOpen);
    element.addEventListener('elisym-status', handleStatus);
    for (const target of closeTargets) {
      target.addEventListener('elisym-close', handleClose);
    }
    return () => {
      element.removeEventListener('elisym-open', handleOpen);
      element.removeEventListener('elisym-status', handleStatus);
      for (const target of closeTargets) {
        target.removeEventListener('elisym-close', handleClose);
      }
    };
  }, []);

  return createElement('elisym-buy', { ...elementAttributes(options), ref: elementRef });
}
