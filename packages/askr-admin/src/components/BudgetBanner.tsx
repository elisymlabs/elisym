import { UPGRADE_TEXT } from '../lib/activation';
import { budgetNotice } from '../lib/budget';
import { npubOf } from '../lib/signer';
import type { StoreView } from '../lib/types';
import { ContactLinks } from './ContactLinks';
import { Notice } from './Notice';

interface Props {
  view: StoreView;
  /** Unix seconds. */
  now: number;
}

/** Above every tab: the chat is paused by a used-up budget, or the month's is nearly used up. */
export function BudgetBanner({ view, now }: Props) {
  const notice = budgetNotice(view, now);
  if (notice === undefined) {
    return null;
  }
  return (
    <Notice tone={notice.tone}>
      <div className="budget-banner flex flex-col gap-6">
        <span>
          {notice.text} {UPGRADE_TEXT}
        </span>
        <ContactLinks storeId={npubOf(view.owner)} />
      </div>
    </Notice>
  );
}
