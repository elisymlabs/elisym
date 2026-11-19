/**
 * What the admin draws, for the drawing of it on this page: its section icons
 * (`packages/askr-admin/src/components/NavIcon.tsx`), its sections and their descriptions
 * (`packages/askr-admin/src/lib/tabs.ts`). Tests keep them equal.
 */

/** Thin line icons for the sections, by section id. */
export const ADMIN_ICON_PATHS = {
  overview: ['M4 13h4v7H4z', 'M10 9h4v11h-4z', 'M16 4h4v16h-4z'],
  settings: [
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  products: ['M3 7l9-4 9 4-9 4-9-4z', 'M3 7v10l9 4 9-4V7', 'M12 11v10'],
  policies: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6', 'M10 17h6'],
  connector: ['M8 7h-1a5 5 0 0 0 0 10h1', 'M16 7h1a5 5 0 0 1 0 10h-1', 'M8 12h8'],
  embed: ['M9 8l-5 4 5 4', 'M15 8l5 4-5 4'],
  keys: [
    'M8 20.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z',
    'M11.2 12.8 20 4',
    'M16.5 7.5l2.5 2.5',
    'M18.5 5.5l2 2',
  ],
} as const;

export const ADMIN_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'settings', label: 'Settings' },
  { id: 'products', label: 'Products' },
  { id: 'policies', label: 'Policies' },
  { id: 'connector', label: 'Connector' },
  { id: 'embed', label: 'Embed' },
  { id: 'keys', label: 'Advanced' },
] as const;

export const OVERVIEW_DESCRIPTION =
  'How your assistant is doing: its status, this plan’s usage and what visitors click.';
