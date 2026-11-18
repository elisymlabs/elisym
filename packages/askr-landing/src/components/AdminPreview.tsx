import { BUTTON } from '../buttons';
import { PRODUCT_NAME } from '../constants';
import { AdminLink } from './AdminLink';
import { AskrMark } from './AskrMark';
import { Eyebrow } from './Eyebrow';
import { Icon, type IconName } from './Icon';
import { Reveal } from './Reveal';

/** The admin's sections, as its sidebar lists them (`packages/askr-admin/src/lib/tabs.ts`). */
const ADMIN_SECTIONS: { icon: IconName; label: string }[] = [
  { icon: 'chart', label: 'Overview' },
  { icon: 'sliders', label: 'Settings' },
  { icon: 'tag', label: 'Products' },
  { icon: 'shield', label: 'Policies' },
  { icon: 'plug', label: 'Connector' },
  { icon: 'code', label: 'Embed' },
  { icon: 'key', label: 'Advanced' },
];

/** Made-up figures for the drawing. */
const TILES = [
  { label: 'Conversations so far', value: '1,284' },
  { label: 'Products', value: '146' },
  { label: 'Product clicks', value: '612' },
];

const CONTROLS = [
  "The assistant's voice and instructions",
  'Products, by hand or from a source',
  'Policies it may quote',
  'Connectors and their sync',
  'Usage against your plan',
  'Conversations and product clicks',
];

export function AdminPreview() {
  return (
    <section id="admin" className="mx-auto max-w-1200 px-16 py-96 sm:px-24 sm:py-160">
      <div className="grid items-center gap-56 lg:grid-cols-[0.75fr_1.25fr]">
        <Reveal className="flex flex-col items-start gap-24">
          <Eyebrow>The admin</Eyebrow>
          <h2 className="text-48 sm:text-64 font-serif leading-[0.98]">
            Everything <em>in one place.</em>
          </h2>
          <p className="text-18 text-text-2 leading-relaxed">
            {`Shape how ${PRODUCT_NAME} talks, what it knows and how it is doing.`}
          </p>
          <ul className="text-15 flex flex-col gap-10">
            {CONTROLS.map((item) => (
              <li key={item} className="flex items-center gap-10">
                <Icon name="check" className="text-accent-ink size-18 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          <AdminLink className={BUTTON.ghost} />
        </Reveal>
        <Reveal delay={1}>
          <figure
            aria-label={`A drawing of the ${PRODUCT_NAME} admin overview`}
            className="rounded-24 border-line overflow-hidden border bg-white shadow-[0_40px_100px_-30px_rgb(23_21_15_/_0.35)]"
          >
            <div className="border-line bg-surface-2/60 flex items-center gap-6 border-b px-16 py-12">
              <span className="bg-line-2 size-10 rounded-full" />
              <span className="bg-line-2 size-10 rounded-full" />
              <span className="bg-line-2 size-10 rounded-full" />
              <span className="bg-bg text-12 text-text-3 mx-auto truncate rounded-full px-12 py-4">
                app.askr.elisym.network/admin
              </span>
            </div>
            <div className="grid sm:grid-cols-[200px_1fr]">
              <ul className="border-line hidden flex-col gap-2 border-r bg-[#f9f9f9] p-12 sm:flex">
                <li className="text-13 mb-8 flex items-center gap-8 px-6 py-4 font-semibold">
                  <AskrMark className="size-20 flex-none [--mark-paper:#f9f9f9]" />
                  Northwind Audio
                </li>
                {ADMIN_SECTIONS.map((item, index) => (
                  <li
                    key={item.label}
                    className={`rounded-8 text-13 flex items-center gap-8 px-10 py-8 ${index === 0 ? 'text-text bg-[#ececec] font-medium' : 'text-text-2'}`}
                  >
                    <Icon name={item.icon} className="size-16" />
                    {item.label}
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-14 p-16 sm:p-20">
                <span className="text-20 font-semibold tracking-[-0.01em]">Overview</span>
                <dl className="grid grid-cols-3 gap-10">
                  {TILES.map((tile) => (
                    <div key={tile.label} className="rounded-12 border-line bg-bg border p-12">
                      <dt className="text-12 text-text-3">{tile.label}</dt>
                      <dd className="text-24 mt-4 font-semibold tracking-[-0.02em] tabular-nums">
                        {tile.value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="rounded-12 border-line bg-bg flex flex-col gap-8 border p-12">
                  <div className="text-12 text-text-3 flex justify-between">
                    <span>Plan usage this month</span>
                    <span>64%</span>
                  </div>
                  <div className="bg-surface-2 h-6 overflow-hidden rounded-full">
                    <div className="bg-accent h-full w-[64%] rounded-full" />
                  </div>
                </div>
                <div className="rounded-12 border-line bg-bg flex flex-col gap-6 border p-12">
                  <span className="text-12 text-text-3">Voice</span>
                  <span className="text-14 text-text-2">
                    Calm and precise. Name the battery life and the warranty.
                  </span>
                </div>
              </div>
            </div>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
