import type { CSSProperties } from 'react';

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function blobGradient(seed: string): CSSProperties {
  const h = hashString(seed || 'x');
  const hue1 = h % 360;
  const hue2 = (hue1 + 80 + ((h >> 9) % 160)) % 360;
  const angle = (h >> 17) % 360;
  return {
    background: `linear-gradient(${angle}deg, hsl(${hue1} 70% 72%) 0%, hsl(${hue2} 70% 62%) 100%)`,
  };
}
