import { type ReactNode, useId } from 'react';
import {
  ARBITRUM_MARK,
  BASE_MARK,
  ETHEREUM_MARK,
  type MarkPath,
  SOLANA_GRADIENT_STOPS,
  SOLANA_MARK_PATH,
  TEMPO_MARK_PATH,
} from '../chain-marks';

export type MockChain = 'solana' | 'tempo' | 'ethereum' | 'arbitrum' | 'base';

type EvmChain = Exclude<MockChain, 'solana' | 'tempo'>;

interface EvmMark {
  disc?: string;
  inset: number;
  viewBox: string;
  paths: readonly MarkPath[];
}

/** Placed as the checkout's glyphs place them (`packages/checkout/src/app/ui/glyphs.ts`). */
const EVM_MARKS: Record<EvmChain, EvmMark> = {
  ethereum: { disc: '#fff', inset: 2, viewBox: '0 0 1920 1920', paths: ETHEREUM_MARK },
  arbitrum: { inset: 0, viewBox: '0 0 1080 1218.5', paths: ARBITRUM_MARK },
  base: { inset: 2, viewBox: '0 0 1280 1280', paths: BASE_MARK },
};

interface Props {
  chain: MockChain;
  className?: string;
}

/** A chain's mark, as the checkout's network picker shows it. */
export function ChainMark({ chain, className = 'size-28' }: Props) {
  const gradient = useId();
  let mark: ReactNode;
  if (chain === 'solana') {
    mark = (
      <>
        <circle cx="12" cy="12" r="12" fill="#111418" />
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
      </>
    );
  } else if (chain === 'tempo') {
    mark = (
      <>
        <circle cx="12" cy="12" r="12" fill="#0b0b0f" />
        <svg x="0" y="0" width="24" height="24" viewBox="0 0 40 40">
          <path fill="#fff" d={TEMPO_MARK_PATH} />
        </svg>
      </>
    );
  } else {
    const evm = EVM_MARKS[chain];
    const size = 24 - evm.inset * 2;
    mark = (
      <>
        {evm.disc !== undefined && <circle cx="12" cy="12" r="12" fill={evm.disc} />}
        <svg x={evm.inset} y={evm.inset} width={size} height={size} viewBox={evm.viewBox}>
          {evm.paths.map((markPath) => (
            <path key={markPath.d} d={markPath.d} fill={markPath.fill} opacity={markPath.opacity} />
          ))}
        </svg>
      </>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      {mark}
    </svg>
  );
}
