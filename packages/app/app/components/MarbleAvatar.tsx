import { useMemo } from 'react';
import { getMarbleColors } from '~/lib/marbleAvatar';

interface MarbleAvatarProps {
  name: string;
  size: number;
}

export function MarbleAvatar({ name, size }: MarbleAvatarProps) {
  const { bg, c1, c2, c3, positions: p } = useMemo(() => getMarbleColors(name), [name]);
  const filterId = `ma-${name.replace(/\W/g, '')}-${size}`;

  return (
    <svg viewBox="0 0 100 100" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="12" />
        </filter>
      </defs>
      <rect width="100" height="100" fill={bg} />
      <circle cx={p.x1} cy={p.y1} r={p.r1} fill={c1} filter={`url(#${filterId})`} opacity="0.8" />
      <circle cx={p.x2} cy={p.y2} r={p.r2} fill={c2} filter={`url(#${filterId})`} opacity="0.8" />
      <circle cx={p.x3} cy={p.y3} r={p.r3} fill={c3} filter={`url(#${filterId})`} opacity="0.7" />
    </svg>
  );
}
