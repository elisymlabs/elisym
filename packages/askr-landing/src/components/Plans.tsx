import { PRODUCT_NAME, X_URL } from '../constants';
import { AdminLink } from './AdminLink';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';

const PLAN_SETS = [
  'A monthly budget for the assistant',
  'How many products it indexes',
  'How often connectors sync',
  `Removing the "by ${PRODUCT_NAME}" label`,
];

export function Plans() {
  return (
    <section id="plans" className="mx-auto max-w-1160 px-16 py-80 sm:px-24 sm:py-112">
      <div className="rounded-24 border-line-2 bg-surface relative isolate grid gap-40 overflow-hidden border px-24 py-48 sm:px-48 sm:py-64 lg:grid-cols-[1.2fr_1fr]">
        <div aria-hidden="true" className="hero-glow absolute inset-0 -z-10" />
        <div className="flex flex-col items-start gap-16">
          <p className="text-13 text-accent-ink font-semibold tracking-wide uppercase">Plans</p>
          <h2 className="text-32 sm:text-40 leading-tight font-semibold tracking-tight">
            Plans are set up on request
          </h2>
          <p className="text-16 sm:text-18 text-text-2 max-w-560 leading-relaxed">
            Create your store in the admin: it stays pending until it is active on a plan. Get in
            touch and we set it up with you.
          </p>
          <div className="mt-16 flex flex-wrap gap-12">
            <ExternalLink
              href={X_URL}
              className="rounded-12 bg-accent text-15 text-accent-text flex items-center gap-8 px-20 py-12 font-semibold transition hover:brightness-95"
            >
              Get in touch
              <Icon name="arrow" className="size-18" />
            </ExternalLink>
            <AdminLink className="rounded-12 border-line-2 bg-bg/60 text-15 hover:bg-surface-2 border px-20 py-12 font-medium" />
          </div>
        </div>
        <div className="flex flex-col gap-12">
          <h3 className="text-15 text-text-2 font-medium">A plan sets</h3>
          <ul className="flex flex-col gap-12">
            {PLAN_SETS.map((item) => (
              <li key={item} className="text-15 flex items-center gap-10">
                <Icon name="check" className="text-accent-ink size-18 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
