import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { type PartnerView as PartnerRead, partnerViewOf } from '../lib/partner';
import { shownTime } from '../lib/store-view';
import { Card } from './Card';
import { PartnerMerchantItem } from './PartnerMerchantItem';
import { VolumeText } from './VolumeText';

interface Props {
  api: ConsoleApi;
}

/**
 * A white-label partner's view, read-only: its paid time, and its merchants'
 * status and volume (never their orders, keys or owner actions).
 */
export function PartnerView({ api }: Props) {
  const [read, setRead] = useState<PartnerRead | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    latest.current += 1;
    const seq = latest.current;
    setLoading(true);
    const answer = await api.request('GET', '/partner');
    if (seq !== latest.current) {
      return;
    }
    setLoading(false);
    const view = answer.status === 200 ? partnerViewOf(answer.body) : undefined;
    if (view !== undefined) {
      setRead(view);
      setError('');
    } else {
      setError(explainAnswer(answer.status === 200 ? undefined : answer.body, answer.status));
    }
  }, [api]);

  useEffect(() => {
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  return (
    <Card title="Your merchants">
      <Button disabled={loading} onClick={() => void load()} className="mt-12">
        Read again
      </Button>
      {read === undefined && loading ? (
        <p className="text-14 text-text-3 mt-12">Loading...</p>
      ) : null}
      {error === '' ? null : (
        <p role="alert" className="text-14 text-error mt-12">
          {error}
        </p>
      )}
      {read === undefined ? null : (
        <>
          <dl className="text-14 mt-12 grid grid-cols-[auto_1fr] gap-x-16 gap-y-4">
            <dt className="text-text-3">Partner</dt>
            <dd className="font-mono">{read.partnerId}</dd>
            <dt className="text-text-3">Paid until</dt>
            <dd>{read.paidUntil === undefined ? 'Not paid yet' : shownTime(read.paidUntil)}</dd>
            <dt className="text-text-3">Since {shownTime(read.volumeSince)}</dt>
            <dd>
              <VolumeText volume={read.volume} />
            </dd>
          </dl>
          {read.merchants.length === 0 ? (
            <p className="text-14 text-text-3 mt-16">No merchants yet.</p>
          ) : (
            <ul className="mt-8">
              {read.merchants.map((merchant) => (
                <PartnerMerchantItem key={merchant.tenantId} merchant={merchant} />
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
