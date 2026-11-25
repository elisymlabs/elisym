import { useEffect, useState } from 'react';
import { followRequest } from '../lib/owner-flow';
import type { StoreSession } from '../lib/store-session';
import type { StoreView } from '../lib/types';
import { BUTTON_SECONDARY } from '../styles';
import { Notice } from './Notice';

interface Props {
  session: StoreSession;
  view: StoreView;
  /** Signed in by a move: the store's setup request, followed with the new owner's signature. */
  requestId?: string;
  onChanged: () => void;
}

export const SWITCHING_TITLE = 'Switching to the new owner key';
export const SWITCHING_EXPLAINED =
  'Your store moved to this owner key. PayCore is publishing it on the relays: until that is done, the store keeps selling on its previous payout list, and payout changes wait.';

/** While the relays do not name the new owner key yet: says so, and follows the move's setup request. */
export function MoveSwitching({ session, view, requestId, onChanged }: Props) {
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const { api, sleep } = session;

  useEffect(() => {
    if (requestId === undefined) {
      return undefined;
    }
    const controller = new AbortController();
    void followRequest(api, requestId, {
      signal: controller.signal,
      ...(sleep === undefined ? {} : { sleep }),
    }).then((followed) => {
      if (controller.signal.aborted) {
        return;
      }
      setFailure(followed.kind === 'failed' ? followed.message : undefined);
      onChanged();
    });
    return () => controller.abort();
  }, [api, sleep, requestId, onChanged]);

  if (view.switching !== true && failure === undefined) {
    return null;
  }
  return (
    <section className="flex flex-col gap-8" aria-labelledby="move-switching-heading">
      <h2 id="move-switching-heading" className="text-16 font-semibold">
        {SWITCHING_TITLE}
      </h2>
      {view.switching === true ? <Notice tone="info">{SWITCHING_EXPLAINED}</Notice> : null}
      {failure === undefined ? null : <Notice tone="error">{failure}</Notice>}
      <div>
        <button type="button" className={BUTTON_SECONDARY} onClick={onChanged}>
          Refresh
        </button>
      </div>
    </section>
  );
}
