import type { PricedPayout } from '@elisym/commerce/buyer';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { payoutPaying } from '../session';
import { ChainGlyph } from './ChainGlyph';
import { payoutLabel } from './text';

interface Props {
  payouts: readonly PricedPayout[];
  selected: number;
  /** A payment is being pressed: nothing can be chosen until the next view. */
  disabled: boolean;
  onChoose(index: number): void;
  /** The id of the "Pay with" label above it. */
  labelId: string;
  /** Dev only (the fixture page): start with the list open. */
  initialOpen?: boolean;
}

/**
 * The payout dropdown: a button and a listbox in the page's flow (an overlay
 * would be cut by the frame). The list takes focus when it opens, by key or by
 * pointer, so Escape there closes the list and never the modal; every key it
 * handles is cancelled, so the browser's own button activation never reopens it.
 */
export function PayoutSelect({
  payouts,
  selected,
  disabled,
  onChoose,
  labelId,
  initialOpen = false,
}: Props) {
  const [openState, setOpen] = useState(initialOpen);
  // A press locks it: an open list closes until the next view.
  const open = openState && !disabled;
  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);
  const [active, setActive] = useState(selected);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /** The next render with the list open moves focus into it. */
  const focusList = useRef(false);
  const id = useId();
  const listId = `${id}-list`;
  const valueId = `${id}-value`;
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    if (open && focusList.current) {
      focusList.current = false;
      list.current?.focus({ preventScroll: true });
    }
  });

  // A pointer pressed outside the button and the list closes it (never a blur).
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const shown = payouts[selected];
  if (shown === undefined) {
    return null;
  }
  const shownPaying = payoutPaying(shown);

  const openList = () => {
    if (disabled) {
      return;
    }
    setActive(selected);
    focusList.current = true;
    setOpen(true);
  };
  const closeToButton = () => {
    button.current?.focus({ preventScroll: true });
    setOpen(false);
  };
  const choose = (index: number) => {
    // Focus first: the list that holds it is about to go.
    button.current?.focus({ preventScroll: true });
    setOpen(false);
    if (index !== selected) {
      onChoose(index);
    }
  };

  const onButtonClick = () => {
    if (open) {
      closeToButton();
    } else {
      openList();
    }
  };
  const onButtonKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openList();
    }
  };
  const onListKeyDown = (event: KeyboardEvent) => {
    const last = payouts.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive(Math.min(last, active + 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActive(Math.max(0, active - 1));
        return;
      case 'Home':
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        event.preventDefault();
        setActive(last);
        return;
      case 'Enter':
        event.preventDefault();
        choose(active);
        return;
      case ' ':
        // Chosen on keyup: a release on the button never clicks it open again.
        event.preventDefault();
        return;
      case 'Escape':
        event.preventDefault();
        closeToButton();
        return;
      case 'Tab':
        // The default Tab then moves on from the button.
        button.current?.focus({ preventScroll: true });
        setOpen(false);
        return;
      default:
        return;
    }
  };
  const onListKeyUp = (event: KeyboardEvent) => {
    if (event.key === ' ') {
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <div class="select-root" ref={root}>
      <button
        type="button"
        class="select"
        ref={button}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-disabled={disabled}
        onClick={onButtonClick}
        onKeyDown={onButtonKeyDown}
      >
        <ChainGlyph chain={shownPaying.chain} />
        <span class="select-value" id={valueId}>
          {payoutLabel(shownPaying)}
        </span>
        <span class="select-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <ul
          class="select-list"
          role="listbox"
          id={listId}
          ref={list}
          tabindex={-1}
          aria-labelledby={labelId}
          aria-activedescendant={optionId(active)}
          onKeyDown={onListKeyDown}
          onKeyUp={onListKeyUp}
        >
          {payouts.map((payout, index) => {
            const paying = payoutPaying(payout);
            return (
              <li
                key={`${payout.target.caip19.id} ${payout.target.address}`}
                id={optionId(index)}
                role="option"
                class="select-option"
                data-active={index === active ? '' : undefined}
                aria-selected={index === selected}
                onClick={() => choose(index)}
              >
                <ChainGlyph chain={paying.chain} />
                <span>{payoutLabel(paying)}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
