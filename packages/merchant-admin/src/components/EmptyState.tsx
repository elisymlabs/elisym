import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

interface Props {
  icon: IconName;
  title: string;
  children?: ReactNode;
}

export function EmptyState({ icon, title, children }: Props) {
  return (
    <div className="flex flex-col items-center gap-8 px-16 py-40 text-center">
      <span className="rounded-12 bg-surface-2 text-text-3 grid size-40 place-items-center">
        <Icon name={icon} className="size-20" />
      </span>
      <p className="text-15 font-medium">{title}</p>
      {children !== undefined && <p className="text-13 text-text-2 max-w-400">{children}</p>}
    </div>
  );
}
