import type { StoreConfig, StorePrivateConfig } from '@elisym/askr';
import type { ConnectorRecord } from '../lib/types';

/** `GET /v1/shopify/store` (`packages/askr-server/src/shopify/app.ts`). */
export interface ShopifyView {
  shop: string;
  onboarded: boolean;
  store: {
    owner: string;
    npub: string;
    onboarding: boolean;
    status: 'pending' | 'active' | 'suspended';
    tier: string | null;
    connector: ConnectorRecord | null;
    delegation: { active: boolean; inCharge: boolean };
  } | null;
}

/** `POST /v1/shopify/onboard/begin`. */
export interface OnboardingKeys {
  catalogKey: string;
  delegate: string;
  now: number;
}

/** `GET /v1/shopify/settings`. */
export interface SettingsRead {
  config: StoreConfig | null;
  private: StorePrivateConfig | null;
  inCharge: boolean;
}

/** What `PUT /v1/shopify/settings` takes: the server fills in the keys and the shop source. */
export interface SettingsInput {
  origins: string[];
  linkOrigins: string[];
  name: string;
  displayName?: string;
  greeting?: string;
  launcherText?: string;
  language: string;
  currency: string;
  contact?: string;
  private: StorePrivateConfig;
}
