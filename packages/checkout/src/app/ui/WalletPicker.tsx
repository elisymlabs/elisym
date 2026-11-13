import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { WalletChoice } from '../session';
import { usableIcon } from './device';
import { useDropdownMotion } from './dropdown-motion';
import { WALLET_BRAND_ICONS } from './wallet-brand-icons';
import { WalletPlaceholderIcon } from './WalletPlaceholderIcon';

interface Props {
  wallets: WalletChoice[];
  disabled: boolean;
  unsupported?: boolean;
  failedWallet?: WalletChoice;
  label?: string;
  showLabel?: boolean;
  actionLabel?: string;
  retryFlow?: boolean;
  secondaryAction?: boolean;
  onPay(name: string): void;
}

function WalletIcon({ wallet }: { wallet: WalletChoice | undefined }) {
  const icon = usableIcon(wallet?.icon) ?? WALLET_BRAND_ICONS[wallet?.name ?? ''];
  const demoNumber = wallet?.name.match(/^Demo wallet (\d+)$/)?.[1];
  const initials =
    demoNumber ??
    wallet?.name
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  const tone = wallet
    ? Array.from(wallet.name).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5
    : 0;
  return icon ? (
    <img class="wallet-icon" src={icon} alt="" />
  ) : (
    <span
      class={
        'monogram wallet-picker-icon' + (wallet ? ' wallet-initials' : ' wallet-placeholder-icon')
      }
      data-tone={tone}
      aria-hidden="true"
    >
      {initials ?? <WalletPlaceholderIcon />}
    </span>
  );
}

/** Choosing a wallet never sends anything. Only the separate action starts a payment. */
export function WalletPicker({
  wallets,
  disabled,
  unsupported = false,
  failedWallet,
  label = 'Choose a wallet',
  showLabel = true,
  actionLabel = 'Pay',
  retryFlow = false,
  secondaryAction = false,
  onPay,
}: Props) {
  const [selected, setSelected] = useState<WalletChoice | undefined>(
    failedWallet ?? (wallets.length === 1 ? wallets[0] : undefined),
  );
  const [openState, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [query, setQuery] = useState('');
  const [changedWallet, setChangedWallet] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  const floor = useRef(false);
  const priorBodyMinHeight = useRef('');
  const id = useId();
  const listId = id + '-wallets';
  const labelId = id + '-label';
  const messageId = id + '-error';
  const open = openState && !disabled;
  const { present, visible } = useDropdownMotion(open);
  const invalid =
    unsupported &&
    (!changedWallet || selected === undefined || selected.name === failedWallet?.name);
  const available = wallets.filter((wallet) => !unsupported || wallet.name !== failedWallet?.name);
  const filtered = available.filter((wallet) =>
    wallet.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  );
  const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));
  const canPay =
    !disabled &&
    !invalid &&
    selected !== undefined &&
    available.some((wallet) => wallet.name === selected.name);

  useEffect(() => {
    if (failedWallet) {
      setSelected(failedWallet);
    }
  }, [failedWallet]);
  useEffect(() => {
    setChangedWallet(false);
  }, [unsupported, failedWallet]);
  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);
  // Removed wallets cannot remain payable; discovery may update while the list is open.
  useEffect(() => {
    if (
      selected &&
      selected.name !== failedWallet?.name &&
      !wallets.some((wallet) => wallet.name === selected.name)
    ) {
      setSelected(undefined);
    }
  }, [wallets, selected, failedWallet]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  useLayoutEffect(() => {
    if (open && present && popover.current) {
      const trigger = root.current?.getBoundingClientRect();
      const card = root.current?.closest('.card')?.getBoundingClientRect();
      if (trigger && card) {
        const stepper = retryFlow
          ? root.current
              ?.closest('.progress-flow')
              ?.querySelector('.stepper')
              ?.getBoundingClientRect()
          : undefined;
        const belowSpace = stepper
          ? stepper.top - trigger.bottom - 8
          : card.bottom - trigger.bottom - 16;
        const aboveSpace = trigger.top - card.top - 16;
        const shouldOpenAbove =
          popover.current.offsetHeight > belowSpace &&
          (stepper !== undefined || aboveSpace > belowSpace);
        if (shouldOpenAbove !== above) {
          setAbove(shouldOpenAbove);
          return;
        }
      }
      const end =
        (root.current?.getBoundingClientRect().top ?? 0) +
        popover.current.offsetTop +
        popover.current.offsetHeight -
        document.body.getBoundingClientRect().top;
      if (!floor.current) {
        priorBodyMinHeight.current = document.body.style.minHeight;
      }
      document.body.style.minHeight = Math.ceil(end + 8) + 'px';
      floor.current = true;
      if (open && focusList.current) {
        focusList.current = false;
        (available.length > 6 ? search.current : list.current)?.focus({ preventScroll: true });
      }
      const option = list.current?.querySelector<HTMLElement>('[data-active]');
      if (open && option && list.current) {
        const top = option.offsetTop - list.current.offsetTop;
        if (top < list.current.scrollTop) {
          list.current.scrollTop = top;
        } else if (top + option.offsetHeight > list.current.scrollTop + list.current.clientHeight) {
          list.current.scrollTop = top + option.offsetHeight - list.current.clientHeight;
        }
      }
    } else if (floor.current) {
      document.body.style.minHeight = priorBodyMinHeight.current;
      floor.current = false;
    }
  });
  useEffect(
    () => () => {
      if (floor.current) {
        document.body.style.minHeight = priorBodyMinHeight.current;
      }
    },
    [],
  );

  const close = () => {
    button.current?.focus({ preventScroll: true });
    setOpen(false);
  };
  const choose = (wallet: WalletChoice | undefined) => {
    if (!open || !wallet || disabled) {
      return;
    }
    setSelected(wallet);
    setChangedWallet(true);
    close();
  };
  const openList = () => {
    if (disabled) {
      return;
    }
    setQuery('');
    setActive(
      Math.max(
        0,
        available.findIndex((wallet) => wallet.name === selected?.name),
      ),
    );
    focusList.current = true;
    setOpen(true);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      button.current?.focus({ preventScroll: true });
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(
        Math.max(
          0,
          Math.min(filtered.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)),
        ),
      );
      list.current?.focus({ preventScroll: true });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(filtered[activeIndex]);
    } else if (event.key === ' ' && event.target === list.current) {
      event.preventDefault();
    } else if (event.target === list.current && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : Math.max(0, filtered.length - 1));
    }
  };

  return (
    <div
      class="wallet-picker unsupported-wallet"
      data-retry-flow={retryFlow ? 'true' : undefined}
    >
      {showLabel ? (
        <h3 class="step-heading wallet-picker-label" id={labelId} tabindex={-1} data-heading="">
          {label}
        </h3>
      ) : (
        <span class="visually-hidden" id={labelId}>
          {label}
        </span>
      )}
      <div class="select-root" ref={root}>
        <button
          type="button"
          class="select wallet-select"
          data-placeholder={selected === undefined ? '' : undefined}
          data-heading={showLabel ? undefined : ''}
          ref={button}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-labelledby={labelId + ' ' + id + '-value'}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? messageId : undefined}
          onClick={() => (open ? close() : openList())}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              openList();
            }
          }}
        >
          <WalletIcon wallet={selected} />
          <span class="select-value" id={id + '-value'}>
            {selected?.name ?? 'Select wallet'}
          </span>
          <span class="select-chevron" aria-hidden="true" />
        </button>
        {present ? (
          <div
            class="wallet-popover"
            data-above={above || undefined}
            data-open={visible || undefined}
            aria-hidden={!open || undefined}
            inert={!open}
            ref={popover}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => {
              if (event.key === ' ' && event.target === list.current) {
                event.preventDefault();
                choose(filtered[activeIndex]);
              }
            }}
          >
            {available.length > 6 ? (
              <div class="wallet-search-field">
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.6" />
                  <path
                    d="m13 13 4 4"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                  />
                </svg>
                <input
                  ref={search}
                  class="wallet-search"
                  type="search"
                  placeholder="Search wallets"
                  aria-label="Search wallets"
                  value={query}
                  onInput={(event) => {
                    setQuery(event.currentTarget.value);
                    setActive(0);
                  }}
                />
              </div>
            ) : null}
            <ul
              class="wallet-options"
              role={open ? 'listbox' : undefined}
              id={listId}
              aria-labelledby={labelId}
              tabindex={-1}
              ref={list}
              aria-activedescendant={filtered.length ? id + '-option-' + activeIndex : undefined}
            >
              {filtered.map((wallet, index) => (
                <li
                  key={wallet.name}
                  class="wallet-option"
                  role={open ? 'option' : undefined}
                  id={id + '-option-' + index}
                  aria-selected={selected?.name === wallet.name}
                  data-active={index === activeIndex ? '' : undefined}
                  onClick={() => choose(wallet)}
                >
                  <WalletIcon wallet={wallet} />
                  <span>{wallet.name}</span>
                  {selected?.name === wallet.name ? (
                    <svg
                      class="wallet-option-indicator"
                      viewBox="0 0 18 18"
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m4 9 3.2 3.2L14 5.5" />
                    </svg>
                  ) : null}
                </li>
              ))}
            </ul>
            {filtered.length === 0 ? (
              <p class="wallet-search-empty">
                {available.length
                  ? 'No matching wallets'
                  : 'No other wallets found in this browser'}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {invalid ? (
        <div
          class="unsupported-wallet-message"
          id={messageId}
          role="alert"
          tabindex={-1}
          data-problem-note=""
        >
          <svg
            class="wallet-info-icon"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <circle cx="8" cy="4.7" r=".85" fill="var(--background)" />
            <path d="M8 7.2V11.5" stroke="var(--background)" stroke-width="1.6" stroke-linecap="round" />
          </svg>
          <p>Selected wallet is not supported. Choose another one.</p>
        </div>
      ) : null}
      <button
        type="button"
        class={
          (secondaryAction ? 'secondary' : 'primary') +
          ' wallet-pay' +
          (secondaryAction ? ' wallet-pay-secondary' : '')
        }
        disabled={!canPay}
        onClick={() => {
          if (canPay && selected) {
            onPay(selected.name);
          }
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}
