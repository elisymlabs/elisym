import { useState } from 'react';
import { Button } from '../../components/Button';
import type { ConsoleApi } from '../lib/api';
import { explainAnswer } from '../lib/errors';
import { fieldOf } from '../lib/fields';
import { domainRecord } from '../lib/settings';
import { Card } from './Card';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  domain: string;
  ownerPubkey: string;
  /** The store key, once the store's home has it (the record names it). */
  storePubkey: string | undefined;
}

type Check =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'done'; ok: boolean; text: string };

/** Level A: the DNS record that ties the domain to this owner and store, and the cloud's check of it. */
export function DomainPanel({ api, tenantId, domain, ownerPubkey, storePubkey }: Props) {
  const [check, setCheck] = useState<Check>({ state: 'idle' });

  const run = async () => {
    setCheck({ state: 'checking' });
    const answer = await api.request('GET', `/tenants/${tenantId}/domain`);
    if (answer.status !== 200) {
      setCheck({ state: 'done', ok: false, text: explainAnswer(answer.body, answer.status) });
      return;
    }
    const reason = fieldOf(answer.body, 'reason');
    const ok = fieldOf(answer.body, 'levelA') === true;
    setCheck({
      state: 'done',
      ok,
      text: ok
        ? `${domain} names this owner and store.`
        : `Not yet: ${typeof reason === 'string' ? reason : 'the domain does not name this store'}.`,
    });
  };

  const record =
    storePubkey === undefined ? undefined : domainRecord(domain, ownerPubkey, storePubkey);
  return (
    <Card title="Your domain">
      {record === undefined ? (
        <p className="text-14 text-text-2 mt-8">
          The store key is still being made: the record to set shows here once it exists.
        </p>
      ) : (
        <>
          <p className="text-14 text-text-2 mt-8 leading-relaxed">
            Add this TXT record at your DNS provider, so buyers can tell {domain} vouches for this
            store and its owner.
          </p>
          <dl className="text-13 mt-12 grid grid-cols-[auto_1fr] gap-x-12 gap-y-4">
            <dt className="text-text-3">Name</dt>
            <dd className="font-mono break-all">{record.name}</dd>
            <dt className="text-text-3">Value</dt>
            <dd className="font-mono break-all">{record.value}</dd>
          </dl>
          <p className="text-13 text-text-3 mt-12 leading-relaxed">
            If https://{domain}/.well-known/nostr.json already names another key under _, buyers see
            a mismatch even with this record: remove that entry or name this store there.
          </p>
          <Button
            disabled={check.state === 'checking'}
            onClick={() => void run()}
            className="mt-16"
          >
            Check the domain
          </Button>
          {check.state === 'done' ? (
            <p
              role={check.ok ? 'status' : 'alert'}
              className={`text-14 mt-8 ${check.ok ? 'text-text' : 'text-error'}`}
            >
              {check.text}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
