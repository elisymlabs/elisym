import { useId } from 'react';
import { SOLANA_GRADIENT_STOPS, SOLANA_MARK_PATH, TEMPO_MARK_PATH } from '../chain-marks';

export type MockChain = 'solana' | 'tempo';

interface Props {
  chain: MockChain;
  className?: string;
}

/** A chain's mark on a dark disc, as the checkout's network picker shows it. */
export function ChainMark({ chain, className = 'size-28' }: Props) {
  const gradient = useId();
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="12" fill="#0b0b0f" />
      {chain === 'solana' ? (
        <svg x="5" y="5.9" width="14" height="12.2" viewBox="0 0 101 88">
          <defs>
            <linearGradient
              id={gradient}
              x1="8.52558"
              y1="90.0973"
              x2="88.9933"
              y2="-3.01622"
              gradientUnits="userSpaceOnUse"
            >
              {SOLANA_GRADIENT_STOPS.map((stop) => (
                <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
              ))}
            </linearGradient>
          </defs>
          <path fill={`url(#${gradient})`} d={SOLANA_MARK_PATH} />
        </svg>
      ) : (
        <svg x="0" y="0" width="24" height="24" viewBox="0 0 40 40">
          <path fill="#fff" d={TEMPO_MARK_PATH} />
        </svg>
      )}
    </svg>
  );
}
