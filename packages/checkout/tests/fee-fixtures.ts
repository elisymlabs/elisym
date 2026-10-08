import type { FeeTerms } from '@elisym/pay-core';

/** Fee terms at a zero rate: no fee leg, every request as it was before the fee. */
export const NO_FEE_TERMS = async (): Promise<FeeTerms> => ({ feeBps: 0, treasury: '' });
