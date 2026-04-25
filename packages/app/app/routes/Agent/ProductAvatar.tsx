import { blobGradient } from './lib/blob';

interface Props {
  name: string;
  size?: number;
}

export function ProductAvatar({ name, size = 40 }: Props) {
  const initial = (name.trim().charAt(0) || '·').toUpperCase();
  return (
    <div
      className="relative flex shrink-0 items-center justify-center font-medium tracking-[-0.02em] text-white select-none"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.32),
        fontSize: Math.round(size * 0.5),
        ...blobGradient(name),
      }}
    >
      {initial}
    </div>
  );
}
