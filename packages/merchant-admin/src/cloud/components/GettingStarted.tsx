import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import type { ConsoleApi } from '../lib/api';
import type { CloudPage } from '../lib/page-locks';
import { nip05Of } from '../lib/settings';
import { type SetupStep, type SetupStepKey, setupSteps } from '../lib/setup-steps';
import type { StoreStatus } from '../lib/status';
import type { StoreView } from '../lib/store-view';
import type { KeptStore } from '../lib/use-kept-store';
import type { StoreStatusPoll } from '../lib/use-status';
import { BillingPanel } from './BillingPanel';
import { Card } from './Card';
import { LaunchChecklist } from './LaunchChecklist';
import { NameStep } from './NameStep';

interface Props {
  api: ConsoleApi;
  tenantId: string;
  view: StoreView;
  npub: string;
  billingUrl: string | undefined;
  navigate: (url: string) => void;
  /** The store changed here (paid, launched): its view is read again. */
  onStoreChanged: () => void;
  poll: StoreStatusPoll;
  kept: KeptStore;
  /** The store's pages that cannot open yet, with why. */
  locks: Partial<Record<CloudPage, string>>;
  /** Opens a page of the store. */
  onOpen: (page: CloudPage) => void;
}

/** The steps done on their own page; the others (pay, name, launch) open here, in their row. */
const STEP_PAGES: Partial<Record<SetupStepKey, CloudPage>> = {
  payouts: 'payouts',
  products: 'products',
  install: 'install',
};

const HINTS: Record<SetupStepKey, string> = {
  plan: '',
  key: '',
  pay: 'The first month: your store is made as soon as it is paid.',
  name: 'The name buyers see in the checkout.',
  payouts: 'The wallets your buyers pay.',
  products: 'What you sell, at what price.',
  install: 'One snippet for your site, with a button for each product.',
  launch: 'The last checks, then your store goes live.',
};

/** Before the store exists only paying opens: its other steps say so (in the pages' own words). */
const NOT_YET = 'Opens once your store is paid.';

/** A step's state for a screen reader: the badge says it by shape and color alone. */
const STATE_WORDS: Record<SetupStep['state'], string> = {
  done: 'Done',
  current: 'Next',
  next: 'To do',
};

const BADGES: Record<SetupStep['state'], string> = {
  done: 'bg-accent-soft text-accent-ink',
  current: 'bg-accent text-accent-text',
  next: 'bg-surface-2 text-text-2',
};

/**
 * Getting started (plan `admin-onboarding.md` 2.5): the store's setup as a
 * checklist on Overview, read from its status alone, so a reload resumes
 * where the data says. Paying, naming and launching open in their row; the
 * other steps open their page. The first step not done is the one action
 * the list leads with.
 */
export function GettingStarted(props: Props) {
  const { poll } = props;
  const status = poll.status;
  if (status === undefined) {
    return (
      <Card title="Getting started">
        <div className="mt-12 flex flex-col items-start gap-8">
          <p role={poll.error === '' ? 'status' : 'alert'} className="text-14 text-text-2">
            {poll.error === '' ? 'Loading...' : poll.error}
          </p>
          {poll.error === '' ? null : (
            <Button size="sm" onClick={poll.watch}>
              Try again
            </Button>
          )}
        </div>
      </Card>
    );
  }
  if (status.gone) {
    return null;
  }
  return <Checklist {...props} status={status} />;
}

/** The checklist itself, over a status read. */
function Checklist({
  api,
  tenantId,
  view,
  npub,
  billingUrl,
  navigate,
  onStoreChanged,
  poll,
  kept,
  locks,
  onOpen,
  status,
}: Props & { status: StoreStatus }) {
  // The step open in its row: undefined follows the one the list leads with, `none` closes them.
  const [chosen, setChosen] = useState<SetupStepKey | 'none' | undefined>(undefined);
  // Where focus goes once the page has it: the name field asked for, or the next step after a save.
  const focusTo = useRef<'name-field' | 'next' | undefined>(undefined);
  const invited = view.launch === 'operator';
  const steps = setupSteps(status, invited).filter(
    (step) => step.key !== 'plan' && step.key !== 'key',
  );
  const current = steps.find((step) => step.state === 'current')?.key ?? 'launch';
  const pageOf = (key: SetupStepKey) => STEP_PAGES[key];
  // A step opens in its row when it has no page, or when its page is shut (it then says why).
  const inRow = (step: SetupStep) => {
    const page = pageOf(step.key);
    return page === undefined || locks[page] !== undefined;
  };
  const inRowKeys = new Set(
    steps.filter((step) => !step.locked && inRow(step)).map((step) => step.key),
  );
  const fallback = inRowKeys.has(current) ? current : undefined;
  let open: SetupStepKey | undefined = fallback;
  if (chosen === 'none') {
    open = undefined;
  } else if (chosen !== undefined && inRowKeys.has(chosen)) {
    open = chosen;
  }
  // Before the store exists, a step after paying says why it waits, in the pages' own words.
  const waitReason = locks.settings === undefined ? NOT_YET : `${locks.settings}.`;
  // A step the merchant edits stays open until they choose another or its save is kept: an
  // advance never hides what they are typing.
  const pin = () => setChosen(open);
  // A step's save kept: its pin goes, and the steps are read again now (not at the next poll).
  const settle = (key: SetupStepKey) => {
    setChosen((was) => (was === key ? undefined : was));
    focusTo.current = 'next';
    poll.watch();
  };

  useEffect(() => {
    if (focusTo.current === 'name-field' && open === 'name') {
      focusTo.current = undefined;
      document.getElementById('setup-store-name')?.focus();
    } else if (focusTo.current === 'next') {
      // A name settles once a status read shows it kept: the step it leads with is past it by then.
      focusTo.current = undefined;
      document.querySelector<HTMLElement>(`li[data-step="${current}"] button`)?.focus();
    }
  }, [open, current]);
  const read = kept.read;

  const bodyOf = (step: SetupStep): ReactNode => {
    const page = pageOf(step.key);
    const reason = page === undefined ? undefined : locks[page];
    if (reason !== undefined) {
      return (
        <div className="flex flex-col items-start gap-8">
          <p className="text-14 text-text-2">{reason}: its payouts go with its name.</p>
          <button
            type="button"
            onClick={() => {
              focusTo.current = 'name-field';
              setChosen('name');
            }}
            className="text-14 text-accent-ink font-medium underline underline-offset-2"
          >
            Name your store
          </button>
        </div>
      );
    }
    switch (step.key) {
      case 'pay':
        return (
          <>
            {status.effectivePaidUntil !== undefined && status.storePubkey === undefined ? (
              <p role="status" className="text-14 text-text-2">
                Paid. Preparing your store: this takes a minute.
              </p>
            ) : null}
            <BillingPanel
              api={api}
              tenantId={tenantId}
              view={view}
              billingUrl={billingUrl}
              navigate={navigate}
              onStale={onStoreChanged}
              level="h3"
            />
          </>
        );
      case 'name':
        return (
          <NameStep
            api={api}
            tenantId={tenantId}
            status={status}
            poll={poll}
            kept={kept}
            onSettled={() => settle('name')}
          />
        );
      case 'launch':
        return (
          <LaunchChecklist
            api={api}
            tenantId={tenantId}
            status={status}
            poll={poll}
            byOperator={invited}
            domain={read === undefined ? undefined : nip05Of(read.form.domain)}
            onLaunched={onStoreChanged}
          />
        );
      default:
        return null;
    }
  };

  return (
    <section aria-labelledby="getting-started" className="flex flex-col gap-12">
      <div className="flex flex-col gap-4">
        <h2 id="getting-started" className="text-18 font-semibold tracking-tight">
          Getting started
        </h2>
        <p className="text-14 text-text-2">
          {invited
            ? 'Set your store up: we launch it with you once it is ready.'
            : 'A few steps, in any order once your store is paid. Launch comes last.'}
        </p>
      </div>
      {invited ? (
        <p className="text-13 text-text-2 leading-relaxed">
          We launch this store for you once it is set up; your access key&apos;s public id is{' '}
          <span className="font-mono break-all">{npub}</span>.
        </p>
      ) : null}
      {poll.expired ? (
        <p className="text-13 text-text-2 flex flex-wrap items-center gap-8">
          Still waiting for your store?
          <Button size="sm" onClick={poll.watch}>
            Read it again
          </Button>
        </p>
      ) : null}
      <ol
        aria-label="Store setup"
        className="rounded-16 border-line bg-surface divide-line flex flex-col divide-y border"
      >
        {steps.map((step, index) => {
          const page = pageOf(step.key);
          const opensHere = inRowKeys.has(step.key);
          const isCurrent = step.key === current;
          return (
            <li
              key={step.key}
              data-step={step.key}
              data-state={step.state}
              aria-current={isCurrent ? 'step' : undefined}
              className="flex flex-col gap-12 px-16 py-14 sm:px-20"
            >
              <div className="flex items-start gap-12">
                <span
                  className={`text-13 mt-2 grid size-24 shrink-0 place-items-center rounded-full font-semibold ${BADGES[step.state]}`}
                >
                  {step.state === 'done' ? (
                    <Icon name="check" className="size-14" />
                  ) : (
                    <span aria-hidden="true">{index + 1}</span>
                  )}
                  <span className="sr-only">{STATE_WORDS[isCurrent ? 'current' : step.state]}</span>
                </span>
                {step.locked ? (
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="text-15 text-text-2 font-medium">{step.label}</span>
                    <span className="text-13 text-text-3">{waitReason}</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (opensHere) {
                        // A disclosure: the open step closes on its own button.
                        setChosen(open === step.key ? 'none' : step.key);
                      } else if (page !== undefined) {
                        onOpen(page);
                      }
                    }}
                    {...(opensHere
                      ? {
                          'aria-expanded': open === step.key,
                          'aria-controls': `step-body-${step.key}`,
                        }
                      : {})}
                    className="group flex min-w-0 flex-1 items-start justify-between gap-12 text-left"
                  >
                    <span className="flex min-w-0 flex-col gap-2">
                      <span
                        className={`text-15 font-medium ${isCurrent ? 'text-text' : 'text-text-2'} group-hover:text-text`}
                      >
                        {step.label}
                      </span>
                      <span className="text-13 text-text-3">{HINTS[step.key]}</span>
                    </span>
                    <Icon
                      name={opensHere ? 'chevron' : 'arrow'}
                      className={`text-text-3 mt-4 size-16 shrink-0 transition ${opensHere && open === step.key ? 'rotate-90' : ''}`}
                    />
                  </button>
                )}
              </div>
              {opensHere ? (
                <div
                  id={`step-body-${step.key}`}
                  data-step-body={step.key}
                  hidden={step.key !== open}
                  onInputCapture={pin}
                  onChangeCapture={pin}
                  className="flex min-w-0 flex-col gap-16 sm:pl-36"
                >
                  {bodyOf(step)}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
