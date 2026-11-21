import { ADMIN_TABS, OVERVIEW_DESCRIPTION } from '../admin-view';
import { PRODUCT_NAME } from '../constants';
import { AdminIcon } from './AdminIcon';
import { AskrMark } from './AskrMark';

/** Made-up figures for the drawing, in the admin's own words and formats. */
const TILES = [
  { label: 'Conversations so far', value: '1,284' },
  { label: 'Open conversations', value: '37' },
  { label: 'Reserved today', value: '$0.42' },
];

/** A plan's only spend limit is its monthly budget, so the month is the one meter. */
const METERS = [{ label: 'This month', text: '$64.10 of $100.00 (64.1%)', width: 'w-[64%]' }];

/** The admin's Overview in a browser window, drawn as the admin draws it: nothing in it is live. */
export function AdminWindow() {
  return (
    <figure
      aria-label={`A drawing of the ${PRODUCT_NAME} admin overview`}
      className="rounded-24 border-line overflow-hidden border bg-white shadow-[0_40px_100px_-30px_rgb(18_19_22/0.35)]"
    >
      <div className="border-line bg-surface-2/60 flex items-center gap-6 border-b px-16 py-12">
        <span className="bg-line-2 size-10 rounded-full" />
        <span className="bg-line-2 size-10 rounded-full" />
        <span className="bg-line-2 size-10 rounded-full" />
        <span className="text-12 text-text-3 mx-auto truncate rounded-full px-12 py-4">
          app.askr.elisym.network/admin
        </span>
      </div>
      <div aria-hidden="true" className="adm flex min-h-[560px]">
        <div className="hidden w-216 flex-none flex-col gap-16 border-r border-[var(--adm-line)] bg-[var(--adm-sidebar)] px-12 py-20 sm:flex">
          <div className="flex items-center gap-10 px-6">
            <AskrMark className="size-24 flex-none" />
            <div className="flex min-w-0 flex-col">
              <span className="text-14 truncate font-semibold">Northwind Audio</span>
              <span className="text-12 truncate font-mono text-[var(--adm-text-3)]">npub1...</span>
            </div>
          </div>
          <ul className="flex flex-col gap-2">
            {ADMIN_TABS.map((tab, index) => (
              <li
                key={tab.id}
                className={`rounded-8 text-14 flex items-center gap-10 px-10 py-7 ${index === 0 ? 'bg-[var(--adm-hover)] font-medium' : 'text-[var(--adm-text-2)]'}`}
              >
                <AdminIcon tab={tab.id} />
                {tab.label}
              </li>
            ))}
          </ul>
          <div className="text-13 mt-auto flex flex-col gap-2 text-[var(--adm-text-2)]">
            <span className="px-10 py-7">Refresh</span>
            <span className="px-10 py-7">Sign out</span>
          </div>
        </div>
        <div className="relative flex min-w-0 flex-1 flex-col gap-28 overflow-hidden px-20 pt-24 pb-64 sm:px-32 sm:pt-32">
          <div className="flex flex-col gap-4">
            <span className="text-24 font-semibold tracking-tight">Overview</span>
            <span className="text-14 text-[var(--adm-text-2)]">{OVERVIEW_DESCRIPTION}</span>
          </div>
          <div className="flex flex-col gap-12">
            <span className="text-15 font-semibold">Status</span>
            <div className="adm-card sm:flex-row sm:items-center sm:gap-12">
              <span className="adm-badge self-start sm:self-auto">Active</span>
              <span className="text-14 text-[var(--adm-text-2)]">
                Your assistant is answering on your site.
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-12">
            <div className="flex flex-col gap-2">
              <span className="text-15 font-semibold">Usage</span>
              <span className="text-13 text-[var(--adm-text-2)]">Plan: Growth</span>
            </div>
            {/* Three tiles in a row only where each fits its label; narrower, one row per tile. */}
            <div className="adm-card @container">
              <dl className="grid grid-cols-1 gap-8 @min-[23rem]:grid-cols-3 @min-[23rem]:gap-12">
                {TILES.map((tile) => (
                  <div
                    key={tile.label}
                    className="rounded-10 flex min-w-0 items-baseline justify-between gap-12 bg-[var(--adm-surface-2)] px-14 py-10 @min-[23rem]:flex-col @min-[23rem]:items-stretch @min-[23rem]:justify-start @min-[23rem]:gap-4 @min-[23rem]:py-12"
                  >
                    <dt className="text-12 min-w-0 break-words text-[var(--adm-text-2)]">
                      {tile.label}
                    </dt>
                    <dd className="text-20 @min-[23rem]:text-24 font-semibold tabular-nums">
                      {tile.value}
                    </dd>
                  </div>
                ))}
              </dl>
              {METERS.map((meter) => (
                <div key={meter.label} className="flex flex-col gap-4">
                  <div className="text-13 flex flex-wrap justify-between gap-x-8 gap-y-2">
                    <span className="font-medium">{meter.label}</span>
                    <span className="text-[var(--adm-text-2)]">{meter.text}</span>
                  </div>
                  <div className="h-6 w-full overflow-hidden rounded-full bg-[var(--adm-surface-2)]">
                    <div className={`h-full rounded-full bg-[var(--adm-text)] ${meter.width}`} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-white" />
        </div>
      </div>
    </figure>
  );
}
