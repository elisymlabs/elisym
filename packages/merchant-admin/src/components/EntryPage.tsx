import { useEffect, useState } from 'react';
import type { ApiAnswer } from '../cloud/lib/api';
import { type TierCard, catalogPaidBy, tierCardsFrom } from '../cloud/lib/tiers';
import {
  CLOUD_DOCS_URL,
  PRICING_URL,
  PRODUCT_NAME,
  STORE_KEY_COMMAND,
  TERMS_URL,
} from '../constants';
import { AuthLayout } from './AuthLayout';
import { Button } from './Button';
import { Code } from './Code';
import { Icon } from './Icon';

interface Props {
  onCreate: () => void;
  onSignIn: () => void;
  /** The plan catalog, read with no key: how the first step says plans are paid. */
  loadTiers: () => Promise<ApiAnswer>;
  termsUrl: string | undefined;
}

interface Question {
  q: string;
  a: string;
}

const QUESTIONS: Question[] = [
  {
    q: 'Do you hold my money?',
    a: 'No. Buyers pay your wallet, and refunds are sent by you from it. We can pause the store itself, for an unpaid plan or a breach of the terms.',
  },
  {
    q: 'What is the access key?',
    a: 'It is your password for this admin. It is made in your browser, we never see it, and you keep it as a file.',
  },
  {
    q: 'What if I lose it?',
    a: 'We cannot restore it; without it you cannot change your payouts or sign in.',
  },
  {
    q: 'Can I leave?',
    a: 'Export the store and run it yourself.',
  },
];

const STEP_CLASS = 'flex gap-16';
const STEP_NUMBER =
  'bg-surface-2 text-13 text-text-2 grid size-28 shrink-0 place-items-center rounded-full font-semibold';

/**
 * The admin's front page in a build with the cloud: what it does, the steps,
 * what a merchant needs, the questions people ask, and the two ways in. Plain
 * words, one column; the catalog only tunes how the first step says plans are
 * paid ("monthly" until it is read, or when no plan can start).
 */
export function EntryPage({ onCreate, onSignIn, loadTiers, termsUrl }: Props) {
  const [tiers, setTiers] = useState<TierCard[] | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void loadTiers().then((answer) => {
      if (current && answer.status === 200) {
        setTiers(tierCardsFrom(answer.body));
      }
    });
    return () => {
      current = false;
    };
  }, [loadTiers]);
  const paidBy = catalogPaidBy(tiers);

  return (
    <AuthLayout>
      <div className="flex w-full max-w-720 flex-col gap-48">
        <section id="entry-hero" className="flex flex-col gap-16 pt-16">
          <h1 className="text-28 sm:text-32 font-semibold tracking-tight">
            Take crypto payments on your site
          </h1>
          <p className="text-18 text-text-2 leading-relaxed">
            Buyers pay in stablecoins straight to your wallet. We run the payment server for you.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-16">
            <Button variant="primary" size="lg" onClick={onCreate}>
              Create a store
            </Button>
            <p className="text-14 text-text-2">
              Already have a store?{' '}
              <button
                type="button"
                onClick={onSignIn}
                className="text-text font-medium underline underline-offset-2"
              >
                Sign in
              </button>
            </p>
          </div>
        </section>

        <section
          id="entry-steps"
          aria-labelledby="entry-steps-title"
          className="flex flex-col gap-20"
        >
          <h2 id="entry-steps-title" className="text-20 font-semibold tracking-tight">
            How it works
          </h2>
          <ol className="flex flex-col gap-20">
            <li className={STEP_CLASS}>
              <span className={STEP_NUMBER}>1</span>
              <p className="text-15 text-text-2 leading-relaxed">
                <span className="text-text font-medium">Choose a plan.</span>{' '}
                <span id="entry-paid-by">
                  {paidBy === undefined ? 'Monthly.' : `Monthly, paid ${paidBy}.`}
                </span>
              </p>
            </li>
            <li className={STEP_CLASS}>
              <span className={STEP_NUMBER}>2</span>
              <p className="text-15 text-text-2 leading-relaxed">
                <span className="text-text font-medium">Save your access key.</span> It is your
                password for this admin: we never see it and cannot restore it, so you download it
                as a file.
              </p>
            </li>
            <li className={STEP_CLASS}>
              <span className={STEP_NUMBER}>3</span>
              <p className="text-15 text-text-2 leading-relaxed">
                <span className="text-text font-medium">Pay the first month.</span>
              </p>
            </li>
            <li className={STEP_CLASS}>
              <span className={STEP_NUMBER}>4</span>
              <p className="text-15 text-text-2 leading-relaxed">
                <span className="text-text font-medium">Set up and go live.</span> Name your store,
                add the wallets you get paid to and your products, paste one line into your site,
                and press Launch.
              </p>
            </li>
          </ol>
        </section>

        <section
          id="entry-needs"
          aria-labelledby="entry-needs-title"
          className="flex flex-col gap-16"
        >
          <h2 id="entry-needs-title" className="text-20 font-semibold tracking-tight">
            What you need
          </h2>
          <ul className="text-15 text-text-2 flex flex-col gap-10 leading-relaxed">
            <li className="flex gap-10">
              <Icon name="check" className="text-accent-ink mt-3 size-18 shrink-0" />A stablecoin
              wallet on Solana or Tempo (Ethereum, Arbitrum and Base can be added next to one).
            </li>
            <li className="flex gap-10">
              <Icon name="check" className="text-accent-ink mt-3 size-18 shrink-0" />A website where
              you can paste one line of HTML.
            </li>
            <li className="flex gap-10">
              <Icon name="check" className="text-accent-ink mt-3 size-18 shrink-0" />A few minutes.
            </li>
          </ul>
        </section>

        <section
          id="entry-questions"
          aria-labelledby="entry-questions-title"
          className="flex flex-col gap-12"
        >
          <h2 id="entry-questions-title" className="text-20 font-semibold tracking-tight">
            Questions
          </h2>
          <div className="border-line divide-line divide-y border-y">
            {QUESTIONS.map((question) => (
              <details key={question.q} className="group py-14">
                <summary className="text-15 flex cursor-pointer list-none items-center justify-between gap-12 font-medium [&::-webkit-details-marker]:hidden">
                  {question.q}
                  <Icon
                    name="chevron"
                    className="text-text-3 size-16 transition group-open:rotate-90"
                  />
                </summary>
                <p className="text-14 text-text-2 mt-8 leading-relaxed">{question.a}</p>
              </details>
            ))}
            <details className="group py-14">
              <summary className="text-15 flex cursor-pointer list-none items-center justify-between gap-12 font-medium [&::-webkit-details-marker]:hidden">
                {`I run ${PRODUCT_NAME} myself`}
                <Icon
                  name="chevron"
                  className="text-text-3 size-16 transition group-open:rotate-90"
                />
              </summary>
              <p className="text-14 text-text-2 mt-8 leading-relaxed">
                Sign in with the store key <Code>{STORE_KEY_COMMAND}</Code> prints: the same field.
              </p>
            </details>
          </div>
        </section>

        <footer className="text-13 text-text-3 flex flex-wrap gap-16">
          <a href={termsUrl ?? TERMS_URL} rel="noopener noreferrer" className="hover:text-text">
            Terms
          </a>
          <a href={PRICING_URL} rel="noopener noreferrer" className="hover:text-text">
            Pricing
          </a>
          <a href={CLOUD_DOCS_URL} rel="noopener noreferrer" className="hover:text-text">
            Docs
          </a>
        </footer>
      </div>
    </AuthLayout>
  );
}
