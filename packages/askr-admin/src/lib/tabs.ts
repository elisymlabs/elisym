export const TABS = [
  {
    id: 'overview',
    label: 'Overview',
    description:
      'How your assistant is doing: its status, this plan’s usage and what visitors click.',
  },
  {
    id: 'billing',
    label: 'Billing',
    description: 'Your plan and every other one: upgrade, switch, cancel, or manage your billing.',
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Your store, where the assistant may answer, and how it speaks.',
  },
  {
    id: 'products',
    label: 'Products',
    description: 'The catalog your assistant recommends from.',
  },
  {
    id: 'policies',
    label: 'Policies',
    description: 'Shipping, returns and other pages the assistant quotes.',
  },
  {
    id: 'connector',
    label: 'Connector',
    description: 'Keep your products in sync with your shop.',
  },
  {
    id: 'embed',
    label: 'Embed',
    description: 'Put the assistant on your site.',
  },
  {
    id: 'keys',
    label: 'Advanced',
    description: 'Your keys, and what to do if one is lost.',
  },
] as const;

export type TabId = (typeof TABS)[number]['id'];
