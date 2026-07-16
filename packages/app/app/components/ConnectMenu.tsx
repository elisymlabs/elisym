import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { track } from '~/lib/analytics';
import { cn } from '~/lib/cn';
import { WalletGlyph } from './WalletGlyph';

interface Props {
  isClosing: boolean;
  onClose: () => void;
  onAnimationEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void;
  /** Opens the provider key dialog (owned by the header). */
  onSignInAsProvider: () => void;
}

/** Role-choice dropdown under the header Connect button. */
export function ConnectMenu({ isClosing, onClose, onAnimationEnd, onSignInAsProvider }: Props) {
  const { setVisible } = useWalletModal();

  function handleCustomer() {
    onClose();
    track('wallet-connect');
    setVisible(true);
  }

  function handleProvider() {
    onClose();
    onSignInAsProvider();
  }

  return (
    <div
      onAnimationEnd={onAnimationEnd}
      className={cn(
        'absolute top-full right-0 z-20 mt-10 w-[min(320px,calc(100vw-24px))] overflow-hidden rounded-3xl border border-black/8 bg-surface text-text',
        'shadow-[0_24px_48px_-16px_rgba(16,16,32,0.18),0_2px_8px_rgba(16,16,32,0.05)]',
        isClosing ? 'dropdown-out' : 'dropdown-in',
      )}
    >
      <div className="px-16 pt-16 pb-6">
        <h3 className="text-sm font-bold text-text">Welcome to elisym</h3>
        <p className="mt-1 text-xs text-text-2">How would you like to jump in?</p>
      </div>
      <div className="p-8">
        <RoleRow
          title="I'm here to hire"
          description="Browse agents and pay as you go."
          iconWrapClass="bg-stat-emerald-bg"
          icon={<WalletGlyph className="size-16 text-stat-emerald" />}
          onClick={handleCustomer}
        />
        <div className="mx-12 my-2 h-px bg-black/5" />
        <RoleRow
          title="I run an agent"
          description="Sign in to read and answer its messages."
          iconWrapClass="bg-stat-indigo-bg"
          icon={<KeyGlyph />}
          onClick={handleProvider}
        />
      </div>
    </div>
  );
}

interface RoleRowProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  iconWrapClass: string;
  onClick: () => void;
}

function RoleRow({ title, description, icon, iconWrapClass, onClick }: RoleRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full cursor-pointer items-center gap-12 rounded-16 border-0 bg-transparent px-12 py-12 text-left transition-colors hover:bg-black/[0.03]"
    >
      <span
        className={cn(
          'flex size-38 shrink-0 items-center justify-center rounded-14 transition-transform group-hover:scale-105',
          iconWrapClass,
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-semibold text-text">{title}</span>
        <span className="mt-1 text-xs leading-snug text-text-2">{description}</span>
      </span>
    </button>
  );
}

function KeyGlyph() {
  return (
    <svg
      aria-hidden
      className="size-16 text-stat-indigo"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 8.3-8.3" />
      <path d="m17 5 2.5 2.5" />
      <path d="m14 8 2.5 2.5" />
    </svg>
  );
}
