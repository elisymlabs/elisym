function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const COLORS = ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'] as const;
const FALLBACK_COLOR = COLORS[0];

export interface MarbleAvatarColors {
  bg: string;
  c1: string;
  c2: string;
  c3: string;
  positions: {
    x1: number;
    y1: number;
    r1: number;
    x2: number;
    y2: number;
    r2: number;
    x3: number;
    y3: number;
    r3: number;
  };
}

export function getMarbleColors(name: string): MarbleAvatarColors {
  const h = hashStr(name);
  const bg = COLORS[h % 5] ?? FALLBACK_COLOR;
  const c1 = COLORS[(h >> 4) % 5] ?? FALLBACK_COLOR;
  const c2 = COLORS[(h >> 8) % 5] ?? FALLBACK_COLOR;
  return {
    bg,
    c1,
    c2,
    c3: bg === c1 ? c2 : bg,
    positions: {
      x1: 10 + (h % 80),
      y1: 10 + ((h >> 3) % 80),
      r1: 30 + (h % 40),
      x2: 10 + ((h >> 6) % 80),
      y2: 10 + ((h >> 9) % 80),
      r2: 25 + ((h >> 5) % 35),
      x3: 10 + ((h >> 12) % 80),
      y3: 10 + ((h >> 15) % 80),
      r3: 20 + ((h >> 10) % 30),
    },
  };
}
