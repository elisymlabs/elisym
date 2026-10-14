import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '@elisym/react/constants';

/** The snippet a merchant pastes, built from the pinned loader `@elisym/react` uses. */
export function htmlSnippet(product = 'naddr1...'): string {
  return [
    `<elisym-buy product="${product}" network="mainnet"></elisym-buy>`,
    '<script',
    `  src="${V3_LOADER_SRC}"`,
    `  integrity="${V3_LOADER_INTEGRITY}"`,
    '  crossorigin="anonymous"',
    '></script>',
  ].join('\n');
}

export function reactSnippet(product = 'naddr1...'): string {
  return [
    "import { ElisymBuy } from '@elisym/react';",
    '',
    `<ElisymBuy product="${product}" network="mainnet" />`,
  ].join('\n');
}
