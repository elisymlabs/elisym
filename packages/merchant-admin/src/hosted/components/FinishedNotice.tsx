import { useState } from 'react';
import type { HostedApi } from '../lib/api';
import { type Finished, refreshRequest } from '../lib/owner-flow';
import { BUTTON_SECONDARY } from '../styles';
import { Notice } from './Notice';

interface Props {
  finished: Finished;
  api: Pick<HostedApi, 'request'>;
  onRefreshed: (finished: Finished) => void;
}

/** How an owner event ended; Refresh while the store is still applying it. */
export function FinishedNotice({ finished, api, onRefreshed }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const { stillId } = finished;

  const refresh = async (id: string) => {
    setRefreshing(true);
    try {
      onRefreshed(await refreshRequest(api, id));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Notice tone={finished.tone}>{finished.message}</Notice>
      {stillId === undefined ? null : (
        <div>
          <button
            type="button"
            className={BUTTON_SECONDARY}
            disabled={refreshing}
            onClick={() => void refresh(stillId)}
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
