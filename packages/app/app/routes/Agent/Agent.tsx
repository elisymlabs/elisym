import {
  formatSol,
  toDTag,
  truncateKey,
  timeAgo,
  nip44Decrypt,
  KIND_JOB_FEEDBACK,
  KIND_JOB_RESULT,
} from '@elisym/sdk';
import type { CapabilityCard } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import Decimal from 'decimal.js-light';
import type { Filter } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Link, useParams } from 'wouter';
import { VerifiedBadge } from '~/components/AgentCard';
import { MarbleAvatar } from '~/components/MarbleAvatar';
import { useAgentBanner } from '~/hooks/useAgentBanner';
import { useAgentDisplay } from '~/hooks/useAgentDisplay';
import { useAgentFeedback } from '~/hooks/useAgentFeedback';
import { useAgents } from '~/hooks/useAgents';
import { useBodyScrollLock } from '~/hooks/useBodyScrollLock';
import { useBuyCapability } from '~/hooks/useBuyCapability';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useLocalQuery } from '~/hooks/useLocalQuery';
import { usePingAgent, type PingStatus } from '~/hooks/usePingAgent';
import { useSolGasFeeEstimate } from '~/hooks/useSolGasFeeEstimate';
import { track } from '~/lib/analytics';
import { compactZeros, formatCardPrice, formatDecimal } from '~/lib/formatPrice';
import { cacheGet, cacheSet } from '~/lib/localCache';

// ─── Verified pubkeys ─────────────────────────────────────────────────────────

const VERIFIED_PUBKEYS = new Set([
  '88b38bac4c1637a2a822eda279f6b2617752ac4ffb631ec7d04c4262cfa2510b',
  '0fbc5c6954fbc4c517fa158f81cbc10ea1940408af027a5bf9b46625f738aac3',
  '46b3c17fb7a36d375ea9d8e89e103f22f48ea7005852fd9590d1651425d72a53',
  '3e85c0f19c61d3f0c8926a50af2709f05dc3e223689b14ea824b6df98b1b68c9',
  '9ab1159ecf8cdad74793eb3890d88eff2a355fa25b0c37d462640f1727f57c59',
  '13fec8e2de4ff3348dba478670d67c247da06d49d821e61e322635463959770b',
  '7ed76f64670efc68522727a298d0267e705a82902e0466e3d5ac158cad0364c5',
  '06a738615c5c2239e3805de6680335d759bbb30b92c217c66dc8d805bafd8b91',
]);

// ─── Banner gradient from pubkey ─────────────────────────────────────────────

function getBannerStyle(pubkey: string): React.CSSProperties {
  const h1 = parseInt(pubkey.slice(0, 2), 16) % 360;
  const h2 = (h1 + 70) % 360;
  const h3 = (h1 + 140) % 360;
  return {
    background: `linear-gradient(135deg, hsl(${h1},35%,18%) 0%, hsl(${h2},45%,25%) 50%, hsl(${h3},40%,20%) 100%)`,
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getBlobStyle(seed: string): React.CSSProperties {
  const h = hashString(seed || 'x');
  const hue1 = h % 360;
  const hue2 = (hue1 + 80 + ((h >> 9) % 160)) % 360;
  const angle = (h >> 17) % 360;
  return {
    background: `linear-gradient(${angle}deg, hsl(${hue1} 70% 72%) 0%, hsl(${hue2} 70% 62%) 100%)`,
  };
}

function ProductAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const initial = (name.trim().charAt(0) || '·').toUpperCase();
  return (
    <div
      className="shrink-0 relative flex items-center justify-center font-medium text-white select-none"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.32),
        fontSize: Math.round(size * 0.5),
        letterSpacing: '-0.02em',
        ...getBlobStyle(name),
      }}
    >
      {initial}
    </div>
  );
}

// ─── ScrambleText ────────────────────────────────────────────────────────────

const SCRAMBLE_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789アイウエオカキクケコサシスセソタチツテトабвгдежзийклмнопрстуфхцчшщ#@$%&*+=<>?/\\';

function ScrambleText({
  text,
  duration = 1000,
  className,
  style,
}: {
  text: string;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [display, setDisplay] = useState(text);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const revealed = Math.floor(t * text.length);
      let out = '';
      for (let i = 0; i < text.length; i++) {
        if (i < revealed || text[i] === ' ' || text[i] === '.') {
          out += text[i];
        } else {
          out += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        }
      }
      setDisplay(out);
      if (t < 1) raf = requestAnimationFrame(tick);
      else {
        setDisplay(text);
        setSettled(true);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, duration]);

  return (
    <span className={className} style={style}>
      {display}
    </span>
  );
}

// ─── FadeInImage ─────────────────────────────────────────────────────────────

function FadeInImage({
  src,
  className,
  alt = '',
}: {
  src: string;
  className?: string;
  alt?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [src]);
  return (
    <img
      src={src}
      alt={alt}
      onLoad={() => setLoaded(true)}
      className={className}
      style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.5s ease' }}
    />
  );
}

// ─── Status dot ──────────────────────────────────────────────────────────────

const STATUS_DOT: Record<PingStatus, string> = {
  pinging: 'ping-pulse',
  online: 'bg-[#1d9e75]',
  offline: 'bg-[#ccc]',
};

const STATUS_LABEL: Record<PingStatus, string> = {
  pinging: 'Checking...',
  online: 'Online',
  offline: 'Offline',
};

// ─── ProductCard ─────────────────────────────────────────────────────────────

function ProductCard({
  card,
  selected,
  onClick,
}: {
  card: CapabilityCard;
  selected: boolean;
  onClick: () => void;
}) {
  const price = card.payment?.job_price;
  const isFree = price === 0;
  const hasPrice = price !== null && price !== undefined;

  return (
    <div
      onClick={onClick}
      style={{
        boxShadow: selected
          ? '0 0 0 4px rgba(0,0,0,0.05), 0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)'
          : '0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        borderColor: selected ? 'rgba(0,0,0,0.14)' : 'rgba(0,0,0,0.07)',
      }}
      className={`group bg-surface rounded-3xl cursor-pointer transition-all flex flex-col overflow-hidden border ${
        selected ? '' : 'hover:shadow-lg hover:-translate-y-0.5'
      }`}
    >
      {/* Image banner */}
      {card.image && (
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-b-2xl bg-surface-2">
          <img
            src={card.image}
            alt={card.name}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <span
            className={`absolute top-3 right-3 size-6 rounded-full flex items-center justify-center transition-all ${
              selected
                ? 'bg-[#101012] text-white shadow-[0_2px_6px_rgba(0,0,0,0.2)]'
                : 'bg-white/70 backdrop-blur-md ring-1 ring-inset ring-black/10 group-hover:bg-white'
            }`}
          >
            {selected && (
              <svg
                className="size-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
        </div>
      )}

      <div className="p-5 flex flex-col gap-4 flex-1">
        {/* Name + selected indicator (when no image banner) */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {!card.image && <ProductAvatar name={card.name} size={40} />}
            <div className="min-w-0">
              <div className="text-sm font-bold line-clamp-1">{card.name}</div>
            </div>
          </div>
          {!card.image && (
            <span
              className={`shrink-0 size-5 rounded-full flex items-center justify-center transition-all ${
                selected ? 'bg-[#101012] text-white' : 'ring-1 ring-inset ring-black/15'
              }`}
            >
              {selected && (
                <svg
                  className="size-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
          )}
        </div>

        {/* Description */}
        {card.description && (
          <p
            className={`text-text-2 text-[13px] leading-relaxed line-clamp-5 m-0 ${card.image ? '-mt-2' : ''}`}
          >
            {card.description}
          </p>
        )}

        {/* Capability tags */}
        {card.capabilities.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {card.capabilities.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="py-1 px-2.5 rounded-full text-[11px] font-semibold uppercase tracking-wide bg-tag-bg text-text-2"
              >
                {tag}
              </span>
            ))}
            {card.capabilities.length > 3 && (
              <span className="text-[11px] text-text-2 opacity-50">
                +{card.capabilities.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Price footer */}
      {hasPrice && (
        <div className="px-5 pb-4">
          <div className="pt-3 border-t border-[rgba(0,0,0,0.06)] flex items-center justify-between text-sm">
            <div>
              <span className="font-bold">
                {isFree ? 'Free' : formatCardPrice(card.payment, price!)}
              </span>
              <span className="text-text-2 ml-1">/ task</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CapabilityDropdown ──────────────────────────────────────────────────────

function CapabilityDropdown({
  cards,
  selectedIndex,
  onSelectIndex,
}: {
  cards: CapabilityCard[];
  selectedIndex: number;
  onSelectIndex: (i: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const multiple = cards.length > 1;
  const current = cards[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => multiple && setOpen((v) => !v)}
        disabled={!multiple}
        className={`inline-flex items-center h-7 pl-3 rounded-full bg-tag-bg text-[11px] font-semibold uppercase tracking-wide text-text-2 outline-none transition-colors ${
          multiple ? 'pr-8 cursor-pointer hover:bg-tag-bg/80' : 'pr-3 cursor-default'
        }`}
      >
        <span className="truncate max-w-[200px]">{current?.name}</span>
        {multiple && (
          <svg
            className={`absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-text-2 pointer-events-none transition-transform ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>
      {open && multiple && (
        <div
          className="absolute left-0 bottom-full mb-2 z-50 min-w-[180px] bg-surface/95 backdrop-blur-xl rounded-2xl border border-[rgba(0,0,0,0.06)] shadow-[0_8px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.04)] p-1.5 flex flex-col gap-0.5 origin-bottom-left"
          style={{ animation: 'dropdown-in 120ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}
        >
          {cards.map((c, i) => {
            const active = i === selectedIndex;
            return (
              <button
                key={c.name}
                type="button"
                onClick={() => {
                  onSelectIndex(i);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2 text-left pl-2.5 pr-3 py-2 rounded-[10px] text-xs font-medium whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-surface-2 text-text'
                    : 'text-text-2 hover:bg-surface-2/60 hover:text-text'
                }`}
              >
                <svg
                  className={`size-3.5 shrink-0 transition-opacity ${active ? 'opacity-100 text-text-2' : 'opacity-0'}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>{c.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── JobInput ────────────────────────────────────────────────────────────────

type BuyState = ReturnType<typeof useBuyCapability>;

interface Artifact {
  id: string;
  cardName: string;
  result: string;
  createdAt: number;
  priceLamports?: number;
  prompt?: string;
  capability?: string;
}

function cleanPreviewText(s: string): string {
  return s
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[=\-*_]{3,}\s*$/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function splitArtifactPreview(result: string): { title: string; body: string } {
  const trimmed = cleanPreviewText(result);
  const nlIdx = trimmed.indexOf('\n');
  const firstLine = nlIdx === -1 ? trimmed : trimmed.slice(0, nlIdx).trim();
  const rest = nlIdx === -1 ? '' : trimmed.slice(nlIdx + 1).trim();
  if (firstLine.length > 0 && firstLine.length <= 80) {
    return { title: firstLine, body: rest };
  }
  const sentenceEnd = trimmed.search(/[.!?](\s|$)/);
  if (sentenceEnd > 0 && sentenceEnd <= 80) {
    return {
      title: trimmed.slice(0, sentenceEnd + 1).trim(),
      body: trimmed.slice(sentenceEnd + 1).trim(),
    };
  }
  return { title: trimmed.slice(0, 72).trim() + (trimmed.length > 72 ? '…' : ''), body: trimmed };
}

function readTime(result: string): string {
  const words = result.trim().split(/\s+/).filter(Boolean).length;
  const mins = Math.max(1, Math.round(words / 200));
  return `${mins} min read`;
}

function formatArtifactTime(createdAt: number): string {
  const ageDays = (Date.now() - createdAt) / 86_400_000;
  if (ageDays < 7) return timeAgo(Math.floor(createdAt / 1000));
  const d = new Date(createdAt);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

function useArtifacts(agentPubkey: string) {
  const storageKey = `elisym:artifacts:${agentPubkey}`;
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setArtifacts(raw ? JSON.parse(raw) : []);
    } catch {
      setArtifacts([]);
    }
  }, [storageKey]);

  const append = (a: Artifact) => {
    setArtifacts((prev) => {
      if (prev.some((x) => x.id === a.id)) return prev;
      const next = [a, ...prev];
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const update = useCallback(
    (id: string, patch: Partial<Artifact>) => {
      setArtifacts((prev) => {
        let changed = false;
        const next = prev.map((a) => {
          if (a.id !== id) return a;
          const merged = { ...a, ...patch };
          if (JSON.stringify(merged) !== JSON.stringify(a)) changed = true;
          return merged;
        });
        if (!changed) return prev;
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    [storageKey],
  );

  return { artifacts, append, update };
}

function ArtifactCapturer({
  buyState,
  card,
  onCapture,
}: {
  buyState: BuyState | null;
  card: CapabilityCard | undefined;
  onCapture: (a: Artifact) => void;
}) {
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!buyState?.result || !buyState.jobId || !card) return;
    if (lastIdRef.current === buyState.jobId) return;
    lastIdRef.current = buyState.jobId;
    onCapture({
      id: buyState.jobId,
      cardName: card.name,
      result: buyState.result,
      createdAt: Date.now(),
      priceLamports: card.payment?.job_price,
      prompt: buyState.lastInput || undefined,
      capability: toDTag(card.name),
    });
  }, [buyState?.result, buyState?.jobId, buyState?.lastInput, card, onCapture]);
  return null;
}

function BuyProviderInner({
  card,
  agentPubkey,
  agentName,
  agentPicture,
  children,
}: {
  card: CapabilityCard;
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  children: (state: BuyState) => React.ReactNode;
}) {
  const state = useBuyCapability({ agentPubkey, agentName, agentPicture, card });
  return <>{children(state)}</>;
}

function BuyProvider({
  card,
  agentPubkey,
  agentName,
  agentPicture,
  children,
}: {
  card: CapabilityCard | undefined;
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  children: (state: BuyState | null) => React.ReactNode;
}) {
  if (!card) return <>{children(null)}</>;
  return (
    <BuyProviderInner
      key={card.name}
      card={card}
      agentPubkey={agentPubkey}
      agentName={agentName}
      agentPicture={agentPicture}
    >
      {children}
    </BuyProviderInner>
  );
}

function JobInputInner({
  card,
  agentPubkey,
  agentName,
  pingStatus,
  allCards,
  selectedIndex,
  onSelectIndex,
  buyState,
}: {
  card: CapabilityCard;
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  pingStatus: PingStatus;
  allCards: CapabilityCard[];
  selectedIndex: number;
  onSelectIndex: (i: number) => void;
  buyState: BuyState;
}) {
  const { publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { relaysConnected } = useElisymClient();
  const idCtx = useIdentity();
  const isOwn = idCtx.publicKey === agentPubkey;

  const { buy, buying, error } = buyState;

  const [input, setInput] = useState('');
  const isStatic = card.static === true;
  const price = card.payment?.job_price;
  const isFree = price === 0;
  const hasPrice = price !== null && price !== undefined;
  const gasFeeLamports = useSolGasFeeEstimate();

  function handleBuy() {
    if (!isFree && !publicKey) {
      track('wallet-connect', { source: 'agent-page' });
      setVisible(true);
      return;
    }
    track('buy', {
      agent: agentName,
      price: price ? formatCardPrice(card.payment, price) : 'free',
    });
    buy(isStatic ? card.name : input);
  }

  function buttonLabel() {
    if (buying) return 'Processing...';
    if (!isFree && !publicKey) return 'Connect Wallet';
    if (hasPrice) return isFree ? 'Get' : 'Buy';
    return 'Submit';
  }

  const isDisabled =
    buying ||
    !relaysConnected ||
    ((!!publicKey || isFree) && !isStatic && !input.trim()) ||
    ((!!publicKey || isFree) && pingStatus !== 'online');

  return (
    <div className="bg-surface rounded-3xl border border-[rgba(0,0,0,0.07)] shadow-[0_1px_8px_rgba(0,0,0,0.05)]">
      <>
        {!isStatic && (
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask ${agentName || 'agent'}…`}
            className="w-full px-5 pt-5 pb-2 text-sm text-text bg-transparent outline-none resize-none min-h-[40px] font-[inherit] placeholder:text-text-2/40"
          />
        )}
        {/* Bottom bar */}
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          {/* Left: product selector + price */}
          <div className="flex items-center gap-2 min-w-0">
            <CapabilityDropdown
              cards={allCards}
              selectedIndex={selectedIndex}
              onSelectIndex={onSelectIndex}
            />

            {hasPrice &&
              (isFree ? (
                <span className="inline-flex items-center h-7 text-xs font-semibold uppercase tracking-wider text-stat-sky bg-stat-sky-bg px-2.5 rounded-full whitespace-nowrap shrink-0">
                  Free
                </span>
              ) : (
                <span className="inline-flex items-center h-7 text-xs font-semibold tabular-nums text-stat-emerald bg-stat-emerald-bg px-2.5 rounded-full whitespace-nowrap shrink-0">
                  {formatCardPrice(card.payment, price!)}
                </span>
              ))}
          </div>

          {/* Right: send */}
          <div className="flex items-center gap-3 shrink-0">
            {!isOwn && hasPrice && !isFree && (
              <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] text-text-2 whitespace-nowrap">
                <svg viewBox="0 0 397.7 311.7" className="size-3" aria-hidden="true">
                  <linearGradient
                    id="sol-a"
                    gradientUnits="userSpaceOnUse"
                    x1="360.88"
                    y1="351.46"
                    x2="141.21"
                    y2="-69.29"
                    gradientTransform="matrix(1 0 0 -1 0 314)"
                  >
                    <stop offset="0" stopColor="#00ffa3" />
                    <stop offset="1" stopColor="#dc1fff" />
                  </linearGradient>
                  <path
                    fill="url(#sol-a)"
                    d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z"
                  />
                </svg>
                <span className="tabular-nums">
                  ~{compactZeros(formatDecimal(gasFeeLamports, 9))} SOL network fee
                </span>
              </span>
            )}
            {!isOwn && hasPrice && (
              <span className="relative group shrink-0">
                <button
                  onClick={handleBuy}
                  disabled={isDisabled}
                  className="inline-flex items-center justify-center gap-2 h-9 px-4 min-w-[92px] rounded-xl bg-[#101012] text-white text-xs font-semibold border-none cursor-pointer hover:bg-[#2a2a2e] disabled:opacity-25 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                >
                  {buying && (
                    <svg className="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="2"
                        opacity="0.3"
                      />
                      <path
                        d="M12 2a10 10 0 0 1 10 10"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                  <span>{buttonLabel()}</span>
                </button>
                {(() => {
                  let tip: string | null = null;
                  if (!buying) {
                    if (!relaysConnected) tip = 'Connecting to relays…';
                    else if ((!!publicKey || isFree) && pingStatus === 'pinging')
                      tip = 'Checking if the agent is available…';
                    else if ((!!publicKey || isFree) && pingStatus !== 'online')
                      tip =
                        "This agent is offline right now, so you can't place an order. Try again later.";
                  }
                  if (!tip) return null;
                  return (
                    <span
                      style={{
                        background: '#101012',
                        color: 'rgba(255,255,255,0.7)',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                        width: '240px',
                      }}
                      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2.5 px-4 py-3 rounded-2xl text-xs leading-relaxed z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      {tip}
                      <svg
                        className="absolute top-full left-1/2 -translate-x-1/2 -mt-px"
                        width="14"
                        height="8"
                        viewBox="0 0 14 8"
                        fill="#101012"
                      >
                        <path d="M0 0 L5.5 6.4 Q7 7.8 8.5 6.4 L14 0 Z" />
                      </svg>
                    </span>
                  );
                })()}
              </span>
            )}
          </div>
        </div>
        {/* Mobile-only gas fee row. On sm+ the fee renders inline next to
              the Buy button; below sm there's no horizontal room for it, so
              we split it onto its own line rather than hide it - users need
              to know the SOL cost before signing. */}
        {!isOwn && hasPrice && !isFree && (
          <div className="flex sm:hidden items-center justify-end gap-1.5 px-4 pb-3 text-[11px] text-text-2 whitespace-nowrap">
            <svg viewBox="0 0 397.7 311.7" className="size-3" aria-hidden="true">
              <linearGradient
                id="sol-a-mobile"
                gradientUnits="userSpaceOnUse"
                x1="360.88"
                y1="351.46"
                x2="141.21"
                y2="-69.29"
                gradientTransform="matrix(1 0 0 -1 0 314)"
              >
                <stop offset="0" stopColor="#00ffa3" />
                <stop offset="1" stopColor="#dc1fff" />
              </linearGradient>
              <path
                fill="url(#sol-a-mobile)"
                d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z"
              />
            </svg>
            <span className="tabular-nums">
              ~{compactZeros(formatDecimal(gasFeeLamports, 9))} SOL network fee
            </span>
          </div>
        )}
        {error && <div className="px-5 pb-3 text-xs text-red-500">{error}</div>}
      </>
    </div>
  );
}

function JobInput({
  agentPubkey,
  agentName,
  agentPicture,
  pingStatus,
  cards,
  selectedIndex,
  onSelectIndex,
  buyState,
}: {
  agentPubkey: string;
  agentName: string;
  agentPicture?: string;
  pingStatus: PingStatus;
  cards: CapabilityCard[];
  selectedIndex: number;
  onSelectIndex: (i: number) => void;
  buyState: BuyState | null;
}) {
  if (cards.length === 0 || !buyState) return null;
  const card = cards[selectedIndex] ?? cards[0]!;

  return (
    <JobInputInner
      key={card.name}
      card={card}
      agentPubkey={agentPubkey}
      agentName={agentName}
      agentPicture={agentPicture}
      pingStatus={pingStatus}
      allCards={cards}
      selectedIndex={selectedIndex}
      onSelectIndex={onSelectIndex}
      buyState={buyState}
    />
  );
}

// ─── AgentActivity ────────────────────────────────────────────────────────────

interface ActivityEvent {
  id: string;
  createdAt: number;
  capability?: string;
  amountLamports?: number;
}

function AgentActivity({
  agentPubkey,
  productCount,
}: {
  agentPubkey: string;
  productCount: number;
}) {
  const { client } = useElisymClient();

  const { data: events } = useLocalQuery<ActivityEvent[]>({
    queryKey: ['agent-public-activity', agentPubkey],
    queryFn: async () => {
      const results = await client.pool.querySync({
        kinds: [KIND_JOB_RESULT],
        authors: [agentPubkey],
        limit: 100,
      } as Filter);

      // Collect job request IDs from results
      const jobIds = results
        .map((ev) => ev.tags.find((t) => t[0] === 'e')?.[1])
        .filter(Boolean) as string[];

      // Fetch payment-required feedbacks specifically for these job IDs
      const feedbacks =
        jobIds.length > 0
          ? await client.pool.queryBatchedByTag(
              { kinds: [KIND_JOB_FEEDBACK], authors: [agentPubkey] } as Filter,
              'e',
              jobIds,
            )
          : [];

      // Map job request id -> amount from payment-required events
      const amountByJobId = new Map<string, number>();
      for (const ev of feedbacks) {
        const statusTag = ev.tags.find((t) => t[0] === 'status');
        if (statusTag?.[1] !== 'payment-required') continue;
        const eTag = ev.tags.find((t) => t[0] === 'e');
        const amountTag = ev.tags.find((t) => t[0] === 'amount');
        const lamports = amountTag?.[1] ? parseInt(amountTag[1], 10) : undefined;
        if (eTag?.[1] && lamports && Number.isFinite(lamports)) {
          amountByJobId.set(eTag[1], lamports);
        }
      }

      return results
        .map((ev) => {
          const eTag = ev.tags.find((t) => t[0] === 'e');
          const capTag = ev.tags.find((t) => t[0] === 't' && t[1] !== 'elisym');
          const amountTag = ev.tags.find((t) => t[0] === 'amount');
          const jobId = eTag?.[1];
          const directAmount = amountTag?.[1] ? parseInt(amountTag[1], 10) : undefined;
          const fallbackAmount = jobId ? amountByJobId.get(jobId) : undefined;
          const amountLamports =
            directAmount && Number.isFinite(directAmount) ? directAmount : fallbackAmount;
          return {
            id: ev.id,
            createdAt: ev.created_at,
            capability: capTag?.[1],
            amountLamports,
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });

  return (
    <div>
      {!events || events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 px-4">
          <p className="text-sm text-text-2 m-0">No activity yet</p>
          <p className="text-sm text-text-2/60 mt-1 m-0">
            Jobs completed by this agent will appear here
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {events.map((ev) => (
            <div
              key={ev.id}
              className="group flex items-center gap-3 py-2 rounded-xl transition-colors"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-2">
                <svg viewBox="0 0 20 20" fill="currentColor" className="size-4" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 0 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium truncate">Job completed</span>
                  {productCount > 1 && ev.capability && (
                    <span className="py-0.5 px-2 rounded-full text-[10px] font-semibold uppercase tracking-wide truncate bg-tag-bg text-text-2">
                      {ev.capability}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-text-2">{timeAgo(ev.createdAt)}</span>
              </div>
              {!ev.amountLamports ? (
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-stat-sky bg-stat-sky-bg px-2.5 py-1 rounded-full">
                  Free
                </span>
              ) : (
                <span className="shrink-0 text-xs font-semibold tabular-nums text-stat-emerald bg-stat-emerald-bg px-2.5 py-1 rounded-full">
                  +{new Decimal(ev.amountLamports).div(1e9).toFixed(4)} SOL
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Agent Page ───────────────────────────────────────────────────────────────

export default function AgentPage() {
  const params = useParams<{ pubkey: string }>();
  const pubkey = params.pubkey ?? '';

  const { data: agents, isLoading } = useAgents();
  const { data: feedbackMap } = useAgentFeedback(pubkey ? [pubkey] : []);

  const agent = useMemo(() => {
    return (agents ?? []).find((a) => a.pubkey === pubkey);
  }, [agents, pubkey]);

  const displayAgents = useAgentDisplay(agent ? [agent] : [], feedbackMap);
  const agentData = agent ? displayAgents[0] : undefined;

  const idCtx = useIdentity();
  const isOwn = idCtx.publicKey === pubkey;
  const pingedStatus = usePingAgent(isOwn || !pubkey ? '' : pubkey);
  const pingStatus: PingStatus = isOwn ? 'online' : pingedStatus;

  const [selectedCardIndex, setSelectedCardIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<'products' | 'artifacts' | 'activity'>('products');
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [appeared, setAppeared] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setAppeared(true), 600);
    return () => clearTimeout(t);
  }, []);
  const appearCls = appeared ? '' : 'appear';
  const { artifacts, append: appendArtifact, update: updateArtifact } = useArtifacts(pubkey);
  const nostrBanner = useAgentBanner(pubkey);
  const { client } = useElisymClient();
  const [ratedArtifacts, setRatedArtifacts] = useState<Set<string>>(new Set());
  const [thanksVisible, setThanksVisible] = useState<Set<string>>(new Set());
  const [thanksMounted, setThanksMounted] = useState<Set<string>>(new Set());
  const [newArtifactIds, setNewArtifactIds] = useState<Set<string>>(new Set());
  const unseenStorageKey = `elisym:unseen-artifacts:${pubkey}`;
  const [unseenArtifactIds, setUnseenArtifactIds] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(`elisym:unseen-artifacts:${pubkey}`);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const persistUnseen = useCallback(
    (ids: Set<string>) => {
      try {
        localStorage.setItem(unseenStorageKey, JSON.stringify([...ids]));
      } catch {}
    },
    [unseenStorageKey],
  );

  useEffect(() => {
    if (artifacts.length === 0) return;
    let cancelled = false;
    Promise.all(
      artifacts.map(async (a) => ((await cacheGet<boolean>(`rated:${a.id}`)) ? a.id : null)),
    ).then((ids) => {
      if (cancelled) return;
      const set = new Set(ids.filter(Boolean) as string[]);
      if (set.size > 0) setRatedArtifacts(set);
    });
    return () => {
      cancelled = true;
    };
  }, [artifacts]);

  useEffect(() => {
    const missing = artifacts.filter((a) => !a.prompt || a.priceLamports == null);
    if (missing.length === 0 || !pubkey) return;
    let cancelled = false;
    (async () => {
      try {
        const ids = missing.map((a) => a.id);
        const [reqs, resMap] = await Promise.all([
          client.pool.querySync({ ids } as any),
          client.marketplace.queryJobResults(idCtx.identity, ids).catch(() => new Map()),
        ]);
        if (cancelled) return;
        for (const a of missing) {
          const req = reqs.find((r: any) => r.id === a.id);
          const patch: Partial<Artifact> = {};
          if (req && !a.prompt) {
            const pTag = req.tags.find((t: string[]) => t[0] === 'p')?.[1];
            const isEncrypted = req.tags.some((t: string[]) => t[0] === 'encrypted');
            try {
              patch.prompt =
                isEncrypted && pTag
                  ? nip44Decrypt(req.content, idCtx.identity.secretKey, pTag)
                  : req.content;
            } catch {
              // skip
            }
          }
          const res = resMap.get(a.id);
          if (res && a.priceLamports == null) {
            patch.priceLamports = res.amount ?? 0;
          }
          if (Object.keys(patch).length > 0) updateArtifact(a.id, patch);
        }
      } catch {
        // silent fail
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifacts, client, idCtx.identity, pubkey, updateArtifact]);

  const rateArtifact = useCallback(
    async (artifact: Artifact, positive: boolean) => {
      if (!artifact.capability || ratedArtifacts.has(artifact.id)) return;
      setRatedArtifacts((prev) => new Set(prev).add(artifact.id));
      setThanksMounted((prev) => new Set(prev).add(artifact.id));
      setThanksVisible((prev) => new Set(prev).add(artifact.id));
      setTimeout(() => {
        setThanksVisible((prev) => {
          const next = new Set(prev);
          next.delete(artifact.id);
          return next;
        });
      }, 3000);
      setTimeout(() => {
        setThanksMounted((prev) => {
          const next = new Set(prev);
          next.delete(artifact.id);
          return next;
        });
      }, 3700);
      try {
        await client.marketplace.submitFeedback(
          idCtx.identity,
          artifact.id,
          pubkey,
          positive,
          artifact.capability,
        );
        await cacheSet(`rated:${artifact.id}`, true);
        track('rate-result', { rating: positive ? 'good' : 'bad' });
      } catch {
        // silent fail
      }
    },
    [client, idCtx.identity, pubkey, ratedArtifacts],
  );

  // Scroll to top and reset card selection when navigating to a new agent
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    setSelectedCardIndex(0);
  }, [pubkey]);

  const displayName = agentData?.name || (pubkey ? truncateKey(nip19.npubEncode(pubkey), 8) : '');

  if (isLoading && !agentData) {
    return createPortal(
      <div
        className="fixed inset-0 z-[9000] flex flex-col items-center justify-center"
        style={{ background: '#fafafa', gap: '28px' }}
      >
        <img src="/logo.svg" alt="" className="logo-loader size-8" />
        <ScrambleText
          text="LOADING AGENT..."
          duration={1000}
          className="text-text-2"
          style={{
            fontFamily: 'monospace',
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.08em',
          }}
        />
      </div>,
      document.body,
    );
  }

  if (!agent || !agentData) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <h1 className="text-xl font-bold mb-2">Agent not found</h1>
          <p className="text-text-2 text-sm mb-4">This agent may be offline or doesn't exist.</p>
          <Link href="/" className="text-accent text-sm hover:underline">
            ← Back to marketplace
          </Link>
        </div>
      </div>
    );
  }

  const cards = agentData.cards;
  const firstTag = agentData.tags[0];
  const feedbackPct =
    agentData.feedbackPositive > 0
      ? Math.round((agentData.feedbackPositive / agentData.feedbackTotal) * 100)
      : null;

  return (
    <div id="light-content" className="pb-16 pt-4">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        {/* ── Profile Header Card ── */}
        <div
          className={`${appearCls} bg-surface rounded-3xl overflow-hidden border border-[rgba(0,0,0,0.07)] shadow-[0_2px_24px_rgba(0,0,0,0.06)] mb-4`}
          style={{ animationDelay: '0ms' }}
        >
          {/* Banner */}
          <div className="relative h-32 w-full overflow-hidden">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                if (window.history.length > 1) window.history.back();
                else window.location.href = '/';
              }}
              className="absolute top-3 left-3 z-10 inline-flex items-center gap-1 py-1 pl-2 pr-3 rounded-full bg-black/35 backdrop-blur-md hover:bg-black/50 border border-white/10 cursor-pointer text-xs font-normal text-white/85 hover:text-white transition-colors"
            >
              <svg
                className="size-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 6 9 12 15 18" />
              </svg>
              Back
            </button>
            <div
              className="relative w-full h-full overflow-hidden"
              style={{ background: '#101012' }}
            >
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background:
                    'radial-gradient(ellipse 140% 200% at 50% 120%, rgba(29,158,117,0.55) 0%, transparent 70%)',
                }}
              />
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background:
                    'radial-gradient(ellipse 100% 150% at 50% 130%, rgba(132,232,200,0.45) 0%, rgba(29,158,117,0.2) 50%, transparent 80%)',
                }}
              />
              {nostrBanner && (
                <FadeInImage
                  src={nostrBanner}
                  className="absolute inset-0 w-full h-full object-cover"
                />
              )}
            </div>
          </div>

          {/* Avatar + info */}
          <div className="px-6 pb-5">
            {/* Avatar */}
            <div
              className="relative"
              style={{
                width: 100,
                height: 100,
                flexShrink: 0,
                marginTop: '-70px',
                marginBottom: '12px',
              }}
            >
              <div
                style={{
                  width: 100,
                  height: 100,
                  borderRadius: '50%',
                  border: '3px solid white',
                  overflow: 'hidden',
                  background: 'var(--color-surface-2, #f5f5f5)',
                }}
              >
                {agentData.picture ? (
                  <img
                    src={agentData.picture}
                    alt={displayName}
                    className="size-full object-cover"
                  />
                ) : (
                  <MarbleAvatar name={pubkey} size={100} />
                )}
              </div>
              <span
                className={`absolute size-3.5 rounded-full border-2 border-white ${STATUS_DOT[pingStatus]}`}
                style={{ bottom: 8, right: 8 }}
              />
            </div>

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {/* Name + verified */}
                <div className="flex items-center gap-1 mb-2">
                  <h1 className="text-xl font-bold leading-tight">
                    {displayName.length > 60 ? displayName.slice(0, 60) + '…' : displayName}
                  </h1>
                  {VERIFIED_PUBKEYS.has(pubkey) && <VerifiedBadge className="size-5" />}
                </div>

                {/* Wallet + stats */}
                <div className="flex items-center gap-4 flex-wrap text-xs text-text-2">
                  {agentData.walletAddress && (
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(agentData.walletAddress!);
                        toast.success('Wallet address copied');
                      }}
                      className="group inline-flex items-center gap-1.5 font-mono opacity-60 hover:opacity-100 transition-opacity bg-transparent border-0 p-0 cursor-pointer"
                      title="Copy wallet address"
                    >
                      {truncateKey(agentData.walletAddress)}
                      <svg
                        className="size-3.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                  )}
                  {agentData.walletAddress &&
                    (cards.length > 0 || agentData.purchases > 0 || feedbackPct !== null) && (
                      <span className="h-3.5 w-px bg-border" aria-hidden="true" />
                    )}
                  {cards.length > 0 && (
                    <span className="flex items-center gap-1.5">
                      <svg
                        className="size-3.5 opacity-50 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 2 L13.6 10.4 L22 12 L13.6 13.6 L12 22 L10.4 13.6 L2 12 L10.4 10.4 Z" />
                      </svg>
                      {cards.length} {cards.length === 1 ? 'product' : 'products'}
                    </span>
                  )}
                  {agentData.purchases > 0 && (
                    <span className="flex items-center gap-1.5">
                      <svg
                        className="size-3.5 opacity-50 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="8" cy="21" r="1" />
                        <circle cx="19" cy="21" r="1" />
                        <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
                      </svg>
                      {agentData.purchases} {agentData.purchases === 1 ? 'order' : 'orders'}
                    </span>
                  )}
                  {feedbackPct !== null && (
                    <span className="flex items-center gap-1.5">
                      <svg
                        className="size-3.5 shrink-0 text-[#1d9e75]"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="12" y1="19" x2="12" y2="5" />
                        <polyline points="5 12 12 5 19 12" />
                      </svg>
                      {feedbackPct}% positive
                    </span>
                  )}
                </div>
              </div>

              {/* Last seen */}
              <div className="text-xs text-text-2 opacity-60 shrink-0 text-right">
                {agentData.lastSeen}
              </div>
            </div>
          </div>
        </div>

        {/* ── 2-column layout ── */}
        <div className="agent-page-grid items-start">
          {/* Left column */}
          <BuyProvider
            card={cards[Math.min(selectedCardIndex, cards.length - 1)]}
            agentPubkey={pubkey}
            agentName={agentData.name}
            agentPicture={agentData.picture}
          >
            {(buyState) => (
              <div className="flex flex-col gap-4 min-w-0">
                {/* Tabbed content */}
                <div
                  className={`${appearCls} bg-surface rounded-3xl p-5 border border-[rgba(0,0,0,0.07)] shadow-[0_1px_8px_rgba(0,0,0,0.05)]`}
                  style={{ animationDelay: '80ms' }}
                >
                  <div className="flex items-center gap-1 mb-5 -mx-1">
                    {(
                      [
                        {
                          id: 'products',
                          label: 'Products',
                          icon: (
                            <svg
                              className="size-3.5"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M12 2 L13.6 10.4 L22 12 L13.6 13.6 L12 22 L10.4 13.6 L2 12 L10.4 10.4 Z" />
                            </svg>
                          ),
                        },
                        {
                          id: 'artifacts',
                          label: 'History',
                          icon: (
                            <svg
                              className="size-3.5"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <circle cx="12" cy="12" r="9" />
                              <polyline points="12 7 12 12 15 14" />
                            </svg>
                          ),
                        },
                        {
                          id: 'activity',
                          label: 'Recent Activity',
                          icon: (
                            <svg
                              className="size-3.5"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="4 7 8 11 4 15" />
                              <line x1="12" y1="15" x2="20" y2="15" />
                            </svg>
                          ),
                        },
                      ] as const
                    ).map((tab) => {
                      const active = activeTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setActiveTab(tab.id)}
                          className={`inline-flex items-center gap-1.5 py-2.5 px-4 rounded-full text-sm font-medium border-0 cursor-pointer transition-colors ${active ? 'bg-tag-bg text-text' : 'bg-transparent text-text-2 hover:bg-tag-bg/60'}`}
                        >
                          <span className="text-text-2">{tab.icon}</span>
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>

                  {activeTab === 'products' &&
                    (cards.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {cards.map((card, i) => (
                          <ProductCard
                            key={card.name}
                            card={card}
                            selected={selectedCardIndex === i}
                            onClick={() => setSelectedCardIndex(i)}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-text-2 py-6 text-center">No products yet.</p>
                    ))}

                  {activeTab === 'artifacts' &&
                    (artifacts.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {artifacts.map((a) => {
                          const preview = cleanPreviewText(a.result);
                          const hasPrice = a.priceLamports != null && a.priceLamports > 0;
                          const knownPrice = a.priceLamports != null;
                          const isNew = newArtifactIds.has(a.id);
                          return (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => setOpenArtifactId(a.id)}
                              style={{
                                boxShadow: '0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
                              }}
                              className="group relative text-left bg-surface rounded-3xl border border-[rgba(0,0,0,0.07)] cursor-pointer transition-all hover:shadow-[0_6px_20px_rgba(0,0,0,0.08)] hover:-translate-y-0.5 overflow-hidden flex flex-col p-6"
                            >
                              {isNew && (
                                <span
                                  aria-hidden
                                  className="absolute top-0 bottom-0 pointer-events-none"
                                  style={{
                                    width: '60%',
                                    background:
                                      'linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.65) 50%, transparent 80%)',
                                    animation: 'artifact-shimmer-sweep 1.4s ease-out 0.15s both',
                                  }}
                                  onAnimationEnd={() => {
                                    setNewArtifactIds((prev) => {
                                      if (!prev.has(a.id)) return prev;
                                      const next = new Set(prev);
                                      next.delete(a.id);
                                      return next;
                                    });
                                  }}
                                />
                              )}
                              <div className="flex items-center gap-3 mb-3 min-w-0">
                                <ProductAvatar name={a.cardName} size={28} />
                                <div className="text-xs font-medium text-text-2 truncate">
                                  {a.cardName}
                                </div>
                                {unseenArtifactIds.has(a.id) && (
                                  <span
                                    className="inline-flex items-center px-2.5 py-[3px] text-[11px] font-semibold rounded-full shrink-0"
                                    style={{
                                      background: 'rgba(16,185,129,0.10)',
                                      color: '#059669',
                                      border: '1px solid rgba(16,185,129,0.25)',
                                    }}
                                  >
                                    New
                                  </span>
                                )}
                              </div>
                              <div className="flex-1 flex flex-col gap-3">
                                {a.prompt && (
                                  <div
                                    className="w-full pl-3 pr-3 py-2 rounded-xl"
                                    style={{
                                      borderLeft: '2px solid #d4d4dc',
                                      background: '#f7f7f9',
                                    }}
                                  >
                                    <div className="text-xs text-text-2 mb-1.5">Prompt</div>
                                    <div className="text-[13px] leading-relaxed text-text line-clamp-2 break-words">
                                      {a.prompt}
                                    </div>
                                  </div>
                                )}
                                {preview && (
                                  <div>
                                    <div className="text-xs text-text-2 mb-1.5">Answer</div>
                                    <div
                                      className="text-[13px] leading-relaxed text-text break-words"
                                      style={{
                                        display: '-webkit-box',
                                        WebkitLineClamp: 2,
                                        WebkitBoxOrient: 'vertical',
                                        overflow: 'hidden',
                                        lineHeight: 1.55,
                                        maxHeight: 'calc(1.55em * 2)',
                                      }}
                                    >
                                      {preview}
                                    </div>
                                  </div>
                                )}
                              </div>
                              <div className="mt-4 pt-3 border-t border-[rgba(0,0,0,0.06)] flex items-center gap-2 text-[11px] text-text-2/70">
                                <span>{formatArtifactTime(a.createdAt)}</span>
                                {knownPrice && (
                                  <span className="ml-auto font-semibold">
                                    {hasPrice ? formatSol(a.priceLamports!) : 'Free'}
                                  </span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-14 px-4">
                        <p className="text-sm text-text-2 m-0">No history yet</p>
                        <p className="text-sm text-text-2/60 mt-1 m-0">
                          Results from your jobs will appear here
                        </p>
                      </div>
                    ))}

                  {activeTab === 'activity' && (
                    <AgentActivity agentPubkey={pubkey} productCount={cards.length} />
                  )}
                </div>

                {/* Job input */}
                {cards.length > 0 && activeTab === 'products' && (
                  <div className={appearCls} style={{ animationDelay: '160ms' }}>
                    <JobInput
                      agentPubkey={pubkey}
                      agentName={agentData.name}
                      agentPicture={agentData.picture}
                      pingStatus={pingStatus}
                      cards={cards}
                      selectedIndex={Math.min(selectedCardIndex, cards.length - 1)}
                      onSelectIndex={setSelectedCardIndex}
                      buyState={buyState}
                    />
                    <p className="text-[11px] text-text-2/50 text-center mt-2 px-4">
                      Agents on Elisym can make mistakes. Always verify important information.
                    </p>
                  </div>
                )}

                <ArtifactCapturer
                  buyState={buyState}
                  card={cards[Math.min(selectedCardIndex, cards.length - 1)]}
                  onCapture={(a) => {
                    appendArtifact(a);
                    setActiveTab('artifacts');
                    setNewArtifactIds((prev) => {
                      const next = new Set(prev);
                      next.add(a.id);
                      return next;
                    });
                    setUnseenArtifactIds((prev) => {
                      const next = new Set(prev);
                      next.add(a.id);
                      persistUnseen(next);
                      return next;
                    });
                  }}
                />
              </div>
            )}
          </BuyProvider>

          {/* Right column */}
          <div className="lg:sticky lg:top-4 flex flex-col gap-4 min-w-0">
            {/* About */}
            {(agentData.description || agentData.tags.length > 0) && (
              <div
                className={`${appearCls} bg-surface rounded-3xl p-5 border border-[rgba(0,0,0,0.07)] shadow-[0_1px_8px_rgba(0,0,0,0.05)]`}
                style={{ animationDelay: '120ms' }}
              >
                <h2 className="text-base font-semibold mb-4">About</h2>
                {agentData.description && (
                  <p className="text-sm text-text-2 leading-relaxed m-0">{agentData.description}</p>
                )}
                {agentData.tags.length > 0 && (
                  <div
                    className={`flex items-center gap-1.5 flex-wrap ${agentData.description ? 'mt-4' : ''}`}
                  >
                    {agentData.tags.map((tag) => (
                      <span
                        key={tag}
                        className="py-1 px-2.5 rounded-full text-[11px] font-semibold uppercase tracking-wide bg-tag-bg text-text-2"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {openArtifactId &&
        (() => {
          const a = artifacts.find((x) => x.id === openArtifactId);
          if (!a) return null;
          return (
            <BuyProvider
              card={cards[Math.min(selectedCardIndex, cards.length - 1)]}
              agentPubkey={pubkey}
              agentName={agentData.name}
              agentPicture={agentData.picture}
            >
              {(buyState) => (
                <ArtifactModal
                  artifact={a}
                  buyState={buyState && buyState.jobId === a.id ? buyState : null}
                  onClose={() => {
                    setOpenArtifactId(null);
                    setNewArtifactIds((prev) => {
                      if (!prev.has(a.id)) return prev;
                      const next = new Set(prev);
                      next.delete(a.id);
                      return next;
                    });
                    setUnseenArtifactIds((prev) => {
                      if (!prev.has(a.id)) return prev;
                      const next = new Set(prev);
                      next.delete(a.id);
                      persistUnseen(next);
                      return next;
                    });
                  }}
                  isRated={ratedArtifacts.has(a.id)}
                  thanksMounted={thanksMounted.has(a.id)}
                  thanksVisible={thanksVisible.has(a.id)}
                  onRate={(positive) => void rateArtifact(a, positive)}
                />
              )}
            </BuyProvider>
          );
        })()}
    </div>
  );
}

function ArtifactModal({
  artifact,
  buyState,
  onClose,
  isRated,
  thanksMounted,
  thanksVisible,
  onRate,
}: {
  artifact: Artifact;
  buyState: BuyState | null;
  onClose: () => void;
  isRated: boolean;
  thanksMounted: boolean;
  thanksVisible: boolean;
  onRate: (positive: boolean) => void;
}) {
  useBodyScrollLock(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const date = new Date(artifact.createdAt);
  const dateStr = date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.result);
      toast.success('Result copied');
    } catch {
      toast.error('Copy failed');
    }
  };

  return createPortal(
    <div
      className="backdrop-in fixed inset-0 bg-black/30 z-[9999] flex items-center justify-center backdrop-blur-md p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-in bg-surface rounded-[20px] w-[760px] max-w-[95vw] max-h-[90vh] overflow-hidden flex flex-col relative"
        style={{ boxShadow: '0 24px 60px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)' }}
      >
        <div className="px-8 pt-7 pb-5 pr-16 flex items-start gap-3 border-b border-[rgba(0,0,0,0.06)]">
          <ProductAvatar name={artifact.cardName} size={40} />
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold leading-tight truncate">
              {artifact.cardName}
            </div>
            <div className="text-xs text-text-2/80 mt-0.5 tabular-nums">{dateStr}</div>
          </div>
          <button
            onClick={copy}
            className="shrink-0 inline-flex items-center gap-2 py-2.5 px-4 rounded-[12px] bg-surface-2 border-0 text-sm font-medium text-text-2 cursor-pointer hover:bg-tag-bg hover:text-text transition-colors"
            title="Copy result"
          >
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy
          </button>
          <button
            onClick={onClose}
            className="absolute top-3 right-3 size-9 flex items-center justify-center bg-transparent border-none text-text-2 cursor-pointer hover:text-text transition-colors z-10 p-0"
            aria-label="Close"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-8 py-7 overflow-y-auto">
          {artifact.prompt && (
            <div
              className="mb-5 w-full rounded-xl px-4 py-3"
              style={{ borderLeft: '2px solid #d4d4dc', background: '#f7f7f9' }}
            >
              <div className="text-xs text-text-2 mb-1.5">Prompt</div>
              <div className="text-sm text-text break-words whitespace-pre-wrap">
                {artifact.prompt}
              </div>
            </div>
          )}
          <div className="text-[15px] text-text leading-[1.65] whitespace-pre-wrap break-words">
            {artifact.result}
          </div>
        </div>
        {artifact.capability && !((isRated || buyState?.rated) && !thanksMounted) && (
          <div
            className="px-8 bg-surface-2/40 flex items-center gap-3 overflow-hidden"
            style={{
              transition: 'opacity 0.6s ease, max-height 0.6s ease, padding 0.6s ease',
              opacity: (isRated || buyState?.rated) && !thanksVisible ? 0 : 1,
              maxHeight: (isRated || buyState?.rated) && !thanksVisible ? 0 : 70,
              height: 70,
              paddingTop: (isRated || buyState?.rated) && !thanksVisible ? 0 : 16,
              paddingBottom: (isRated || buyState?.rated) && !thanksVisible ? 0 : 16,
            }}
          >
            {isRated || buyState?.rated ? (
              thanksMounted && <p className="text-xs text-text-2 m-0">Thanks for your feedback!</p>
            ) : (
              <>
                <span className="text-xs text-text-2">How was this result?</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      onRate(true);
                      buyState?.rate(true);
                    }}
                    className="text-[12px] font-medium px-3 py-1.5 rounded-full border border-[rgba(0,0,0,0.1)] bg-surface hover:bg-[rgba(0,0,0,0.04)] transition-colors cursor-pointer"
                  >
                    👍 Good
                  </button>
                  <button
                    onClick={() => {
                      onRate(false);
                      buyState?.rate(false);
                    }}
                    className="text-[12px] font-medium px-3 py-1.5 rounded-full border border-[rgba(0,0,0,0.1)] bg-surface hover:bg-[rgba(0,0,0,0.04)] transition-colors cursor-pointer"
                  >
                    👎 Bad
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
