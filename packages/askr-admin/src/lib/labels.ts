import {
  CONNECTOR_PLATFORMS,
  type ConnectorPlatform,
  PRODUCT_SOURCES,
  type ProductSourceKind,
} from '@elisym/askr';
import type { FormSourceKind } from './store-form';

export const SOURCE_LABELS: Readonly<Record<ProductSourceKind, string>> = {
  admin: 'Here in the admin (CSV import and product editor)',
  catalog: 'My own catalog key (SDK, MCP or my backend)',
  connector: 'My online shop or product feed (connector)',
};

export const PLATFORM_LABELS: Readonly<Record<ConnectorPlatform, string>> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  google: 'Google product feed',
};

/** The form's sources: the config's, plus a PayCore store (saved as a catalog source, C1). */
export const FORM_SOURCE_LABELS: Readonly<Record<FormSourceKind, string>> = {
  ...SOURCE_LABELS,
  paycore: 'My PayCore store (products with a Buy button in the chat)',
};

const FORM_SOURCES: readonly FormSourceKind[] = [...PRODUCT_SOURCES, 'paycore'];

export const SOURCE_OPTIONS = FORM_SOURCES.map((source) => ({
  value: source,
  label: FORM_SOURCE_LABELS[source],
}));

export const PLATFORM_OPTIONS = CONNECTOR_PLATFORMS.map((platform) => ({
  value: platform,
  label: PLATFORM_LABELS[platform],
}));

export function sourceKindOf(value: string): FormSourceKind | undefined {
  return FORM_SOURCES.find((source) => source === value);
}

export function platformOf(value: string): ConnectorPlatform | undefined {
  return CONNECTOR_PLATFORMS.find((platform) => platform === value);
}
