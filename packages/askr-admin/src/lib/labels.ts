import {
  CONNECTOR_PLATFORMS,
  type ConnectorPlatform,
  PRODUCT_SOURCES,
  type ProductSourceKind,
} from '@elisym/askr';

export const SOURCE_LABELS: Readonly<Record<ProductSourceKind, string>> = {
  admin: 'Here in the admin (CSV import and product editor)',
  catalog: 'My own catalog key (SDK, MCP or my backend)',
  connector: 'My online shop or product feed (connector)',
  paycore: 'An existing Pay Core store',
};

export const PLATFORM_LABELS: Readonly<Record<ConnectorPlatform, string>> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  google: 'Google product feed',
};

export const SOURCE_OPTIONS = PRODUCT_SOURCES.map((source) => ({
  value: source,
  label: SOURCE_LABELS[source],
}));

export const PLATFORM_OPTIONS = CONNECTOR_PLATFORMS.map((platform) => ({
  value: platform,
  label: PLATFORM_LABELS[platform],
}));

export function sourceKindOf(value: string): ProductSourceKind | undefined {
  return PRODUCT_SOURCES.find((source) => source === value);
}

export function platformOf(value: string): ConnectorPlatform | undefined {
  return CONNECTOR_PLATFORMS.find((platform) => platform === value);
}
