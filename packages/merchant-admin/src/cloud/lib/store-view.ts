/**
 * The owner view (`GET /tenants/:id`) as the console reads it: every field
 * checked, so a malformed answer is a failure, never "undefined" on screen.
 */
import { fieldOf } from './fields';

/** Why a payment step is not open now, as cloud-api's rails say it. */
export interface RailRefusal {
  code: string;
  /** For `card_from`: when card checkout opens. */
  from?: number;
}

export interface RailView {
  open: boolean;
  refusal: RailRefusal | undefined;
}

export interface StoreView {
  tier: string;
  /** The plan as the catalog names it. */
  tierName: string;
  network: string;
  activated: boolean;
  /** Who activates it: the console's Launch, or the operator. */
  launch: 'console' | 'operator';
  paidUntil: number | undefined;
  /** The white-label partner it is attached to: its paid time counts as the store's own. */
  partner: { paidUntil: number | undefined } | undefined;
  /** In retention: pay by then. */
  payBy: number | undefined;
  card: RailView;
  crypto: RailView;
  /** Off sale (withdrawn by the owner or the cloud): edits are saved and go out at Resume. */
  withdrawn: boolean;
  /** Off sale since then. */
  withdrawnAt: number | undefined;
  /** The owner took it off sale: it stays so, paid or not, until the owner's Resume. */
  ownerWithdrawn: boolean;
  /** The operator holds it (no Resume from the console). */
  held: boolean;
  /** Its node is stopped (after the dwell). */
  stopped: boolean;
  /** An export is asked and not done yet (a failed step is retried by the cloud): the store is leaving. */
  exporting: boolean;
  /**
   * The last export stopped for the owner, not retried: its leave setup refused the payout
   * list (`resign`: sign it again) or the store's authorization (`revoked`).
   */
  exportStopped: 'resign' | 'revoked' | undefined;
  /** Exported: the store left the cloud (terminal). */
  exported: ExportView | undefined;
}

export interface ExportView {
  exportedAt: number | undefined;
  /** The handover archive is packed and can be downloaded. */
  archiveReady: boolean;
  /** When the cloud destroys its copy, unless the owner confirms its own node first. */
  destroyAt: number | undefined;
}

/** The last second a date can show (9999-12-31): a later one is no time the console can print. */
const MAX_TIME_SECS = 253_402_300_799;

export function isTime(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TIME_SECS
  );
}

export function optionalTime(value: unknown): number | undefined | 'bad' {
  if (value === null || value === undefined) {
    return undefined;
  }
  return isTime(value) ? value : 'bad';
}

function railOf(value: unknown): RailView | undefined {
  const open = fieldOf(value, 'open');
  const refusal = fieldOf(value, 'refusal');
  if (typeof open !== 'boolean') {
    return undefined;
  }
  if (refusal === undefined || refusal === null) {
    return { open, refusal: undefined };
  }
  const code = fieldOf(refusal, 'code');
  const from = fieldOf(refusal, 'from');
  if (typeof code !== 'string' || (from !== undefined && !isTime(from))) {
    return undefined;
  }
  return { open, refusal: { code, ...(isTime(from) ? { from } : {}) } };
}

function partnerOf(value: unknown): { paidUntil: number | undefined } | undefined | 'bad' {
  if (value === null) {
    return undefined;
  }
  if (typeof value !== 'object') {
    return 'bad';
  }
  const paidUntil = optionalTime(fieldOf(value, 'paidUntil'));
  return paidUntil === 'bad' ? 'bad' : { paidUntil };
}

function exportOf(value: unknown): ExportView | undefined | 'bad' {
  if (value === null) {
    return undefined;
  }
  const exportedAt = optionalTime(fieldOf(value, 'exportedAt'));
  const archiveReady = fieldOf(value, 'archiveReady');
  const destroyAt = optionalTime(fieldOf(value, 'destroyAt'));
  if (exportedAt === 'bad' || typeof archiveReady !== 'boolean' || destroyAt === 'bad') {
    return 'bad';
  }
  return { exportedAt, archiveReady, destroyAt };
}

/** The view from an answer's body, or undefined when any field is not what it must be. */
export function storeViewOf(body: unknown): StoreView | undefined {
  const tier = fieldOf(body, 'tier');
  const tierName = fieldOf(body, 'tierName');
  const network = fieldOf(body, 'network');
  const activated = fieldOf(body, 'activated');
  const launch = fieldOf(body, 'launch');
  const paidUntil = optionalTime(fieldOf(body, 'paidUntil'));
  const payBy = optionalTime(fieldOf(body, 'payBy'));
  const partner = partnerOf(fieldOf(body, 'partner'));
  const rails = fieldOf(body, 'rails');
  const card = railOf(fieldOf(rails, 'card'));
  const crypto = railOf(fieldOf(rails, 'crypto'));
  const sale = fieldOf(body, 'sale');
  const withdrawnAt = optionalTime(fieldOf(sale, 'withdrawnAt'));
  const ownerWithdrawn = fieldOf(sale, 'ownerWithdrawn');
  const held = fieldOf(sale, 'held');
  const stopped = fieldOf(sale, 'stopped');
  const exporting = fieldOf(body, 'exporting');
  const exportStopped = fieldOf(body, 'exportStopped');
  const exported = exportOf(fieldOf(body, 'export'));
  if (
    typeof tier !== 'string' ||
    typeof tierName !== 'string' ||
    typeof network !== 'string' ||
    typeof activated !== 'boolean' ||
    (launch !== 'console' && launch !== 'operator') ||
    paidUntil === 'bad' ||
    partner === 'bad' ||
    payBy === 'bad' ||
    card === undefined ||
    crypto === undefined ||
    withdrawnAt === 'bad' ||
    typeof ownerWithdrawn !== 'boolean' ||
    typeof held !== 'boolean' ||
    typeof stopped !== 'boolean' ||
    typeof exporting !== 'boolean' ||
    (exportStopped !== null && exportStopped !== 'resign' && exportStopped !== 'revoked') ||
    exported === 'bad'
  ) {
    return undefined;
  }
  return {
    tier,
    tierName,
    network,
    activated,
    launch,
    paidUntil,
    partner,
    payBy,
    card,
    crypto,
    withdrawn: withdrawnAt !== undefined,
    withdrawnAt,
    ownerWithdrawn,
    held,
    stopped,
    exporting,
    exportStopped: exportStopped === null ? undefined : exportStopped,
    exported,
  };
}

/** A unix time as the console shows it: the UTC day and minute. */
export function shownTime(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
