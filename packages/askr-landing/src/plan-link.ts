import type { Billing } from './components/BillingSwitch';
import { ADMIN_URL, type FlatPlan } from './constants';

/** The billing period as the admin reads it from the link: the landing's switch, renamed. */
const INTERVAL_OF_BILLING: Record<Billing, 'month' | 'year'> = { monthly: 'month', yearly: 'year' };

/**
 * Where "Choose <Plan>" goes: the admin, told the plan and the billing period, so the owner pays
 * for that one once their key is made. The plan is its name in lower case (`starter`, `growth`,
 * `pro`, `scale`), as the admin and the server name the paid plans.
 */
export function choosePlanUrl(plan: FlatPlan, billing: Billing): string {
  const url = new URL(ADMIN_URL);
  url.searchParams.set('plan', plan.name.toLowerCase());
  url.searchParams.set('interval', INTERVAL_OF_BILLING[billing]);
  return url.toString();
}
