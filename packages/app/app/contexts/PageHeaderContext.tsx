import { createContext, useContext, useState, type ReactNode } from 'react';

export interface PageHeaderInfo {
  name: string;
  picture?: string;
  pubkey: string;
  verified: boolean;
  subtitle?: string;
}

interface PageHeaderCtx {
  info: PageHeaderInfo | null;
  setInfo: (info: PageHeaderInfo | null) => void;
}

const Ctx = createContext<PageHeaderCtx | null>(null);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<PageHeaderInfo | null>(null);
  return <Ctx.Provider value={{ info, setInfo }}>{children}</Ctx.Provider>;
}

export function usePageHeader(): PageHeaderCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePageHeader must be used within PageHeaderProvider');
  return ctx;
}
