export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'settings', label: 'Settings' },
  { id: 'products', label: 'Products' },
  { id: 'policies', label: 'Policies' },
  { id: 'connector', label: 'Connector' },
  { id: 'embed', label: 'Embed' },
  { id: 'keys', label: 'Advanced' },
] as const;

export type TabId = (typeof TABS)[number]['id'];
