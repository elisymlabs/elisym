import { ApiError } from '../lib/api';
import { errorMessage } from '../lib/errors';
import type { StoreView } from '../lib/types';
import { Notice } from './Notice';

interface Props {
  view: StoreView;
  /** Opens Billing, where the plan is chosen; without it the line has no button. */
  onChoosePlan?: () => void;
  /** What waits for a plan, as in "Choose a plan to add products". */
  noun: string;
}

/**
 * Why writes wait: a store with no plan chooses one; one pending with a plan,
 * or suspended, is the operator's (the server's `inactive` refusal).
 */
export function NeedsActiveStore({ view, onChoosePlan, noun }: Props) {
  if (view.status === 'active') {
    return null;
  }
  if (view.status === 'pending' && view.tier === null) {
    return (
      <Notice tone="info">
        <span className="flex flex-wrap items-center gap-8">
          Choose a plan to {noun}.
          {onChoosePlan === undefined ? null : (
            <button type="button" className="btn btn-primary btn-sm" onClick={onChoosePlan}>
              Choose a plan
            </button>
          )}
        </span>
      </Notice>
    );
  }
  return <Notice tone="info">{errorMessage(new ApiError(409, 'inactive'))}</Notice>;
}
