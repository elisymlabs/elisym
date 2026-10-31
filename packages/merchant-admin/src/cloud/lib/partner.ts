/**
 * The partner view (`GET /partner`) as the console reads it: every field
 * checked, so a malformed answer is a failure, never "undefined" on screen.
 */
import { fieldOf } from './fields';
import { isTime, optionalTime } from './store-view';

/** A partner invite says its kind: the console sends it to the partner redemption. */
export const PARTNER_INVITE_PREFIX = 'partner-';

const STATUSES = ['invited', 'setting_up', 'on_sale', 'off_sale', 'held', 'stopped'] as const;
export type MerchantStatus = (typeof STATUSES)[number];

/** Paid orders in the window, and what they paid per CAIP-19 asset (subunits). */
export interface Volume {
  orders: number;
  paid: [asset: string, amount: string][];
}

export interface PartnerMerchantView {
  tenantId: string;
  tier: string;
  /** The plan as the catalog names it. */
  tierName: string;
  network: string;
  status: MerchantStatus;
  paidUntil: number | undefined;
  /** Undefined while its orders cannot be read. */
  volume: Volume | undefined;
}

export interface PartnerView {
  partnerId: string;
  paidUntil: number | undefined;
  volumeSince: number;
  volume: Volume;
  merchants: PartnerMerchantView[];
}

/** What the partner reads for a merchant's status. */
export const STATUS_TEXT: Record<MerchantStatus, string> = {
  invited: 'Invited, not redeemed yet',
  setting_up: 'Setting up',
  on_sale: 'On sale',
  off_sale: 'Off sale',
  held: 'On hold',
  stopped: 'Stopped',
};

const SUBUNITS = /^(0|[1-9][0-9]*)$/;

function volumeOf(value: unknown): Volume | undefined {
  const orders = fieldOf(value, 'orders');
  const paid = fieldOf(value, 'paid');
  if (
    typeof orders !== 'number' ||
    !Number.isInteger(orders) ||
    orders < 0 ||
    paid === null ||
    typeof paid !== 'object' ||
    Array.isArray(paid)
  ) {
    return undefined;
  }
  const entries = Object.entries(paid);
  if (!entries.every(([, amount]) => typeof amount === 'string' && SUBUNITS.test(amount))) {
    return undefined;
  }
  return {
    orders,
    paid: entries.map(([asset, amount]): [string, string] => [asset, String(amount)]),
  };
}

function merchantOf(value: unknown): PartnerMerchantView | undefined {
  const tenantId = fieldOf(value, 'tenantId');
  const tier = fieldOf(value, 'tier');
  const tierName = fieldOf(value, 'tierName');
  const network = fieldOf(value, 'network');
  const status = STATUSES.find((each) => each === fieldOf(value, 'status'));
  const paidUntil = optionalTime(fieldOf(value, 'paidUntil'));
  const rawVolume = fieldOf(value, 'volume');
  const volume = rawVolume === null ? undefined : volumeOf(rawVolume);
  if (
    typeof tenantId !== 'string' ||
    typeof tier !== 'string' ||
    typeof tierName !== 'string' ||
    typeof network !== 'string' ||
    status === undefined ||
    paidUntil === 'bad' ||
    (rawVolume !== null && volume === undefined)
  ) {
    return undefined;
  }
  return { tenantId, tier, tierName, network, status, paidUntil, volume };
}

/** The view from an answer's body, or undefined when any field is not what it must be. */
export function partnerViewOf(body: unknown): PartnerView | undefined {
  const partnerId = fieldOf(body, 'partnerId');
  const paidUntil = optionalTime(fieldOf(body, 'paidUntil'));
  const volumeSince = fieldOf(body, 'volumeSince');
  const volume = volumeOf(fieldOf(body, 'volume'));
  const rawMerchants = fieldOf(body, 'merchants');
  const merchants = Array.isArray(rawMerchants) ? rawMerchants.map(merchantOf) : undefined;
  if (
    typeof partnerId !== 'string' ||
    paidUntil === 'bad' ||
    !isTime(volumeSince) ||
    volume === undefined ||
    merchants === undefined
  ) {
    return undefined;
  }
  const checked = merchants.flatMap((merchant) => (merchant === undefined ? [] : [merchant]));
  if (checked.length !== merchants.length) {
    return undefined;
  }
  return { partnerId, paidUntil, volumeSince, volume, merchants: checked };
}
