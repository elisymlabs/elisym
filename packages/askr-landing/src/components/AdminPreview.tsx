import { PRODUCT_NAME } from '../constants';
import { AdminLink } from './AdminLink';
import { Icon, type IconName } from './Icon';
import { SectionHeading } from './SectionHeading';

const MENU: { icon: IconName; label: string }[] = [
  { icon: 'chart', label: 'Overview' },
  { icon: 'chat', label: 'Assistant' },
  { icon: 'tag', label: 'Products' },
  { icon: 'shield', label: 'Policies' },
  { icon: 'plug', label: 'Connectors' },
  { icon: 'key', label: 'Keys' },
];

/** Made-up figures for the drawing. */
const TILES = [
  { label: 'Conversations', value: '1,284' },
  { label: 'Open now', value: '37' },
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
    <section id="admin" className="mx-auto max-w-1200 px-16 py-80 sm:px-24 sm:py-112">
      <div className="grid items-center gap-48 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="flex flex-col items-start gap-28">
          <SectionHeading eyebrow="The admin" title="Everything in one place">
            {`Shape how ${PRODUCT_NAME} talks, what it knows and how it is doing.`}
          </SectionHeading>
          <ul className="text-15 flex flex-col gap-10">
            {CONTROLS.map((item) => (
              <li key={item} className="flex items-center gap-10">
                <Icon name="check" className="text-accent-ink size-18 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          <AdminLink className="rounded-12 border-line-2 text-15 hover:bg-surface-2 border px-20 py-12 font-medium" />
        </div>
        <figure
          aria-label={`A drawing of the ${PRODUCT_NAME} admin overview`}
          className="rounded-24 border-line-2 bg-surface overflow-hidden border shadow-2xl shadow-black/20"
        >
          <div className="border-line flex items-center gap-6 border-b px-16 py-12">
            <span className="bg-line-2 size-10 rounded-full" />
            <span className="bg-line-2 size-10 rounded-full" />
            <span className="bg-line-2 size-10 rounded-full" />
            <span className="text-12 text-text-3 ml-12 truncate">
              api.askr.elisym.network/admin
            </span>
          </div>
          <div className="grid sm:grid-cols-[180px_1fr]">
            <ul className="border-line hidden flex-col gap-4 border-r p-12 sm:flex">
              {MENU.map((item, index) => (
                <li
                  key={item.label}
                  className={`rounded-8 text-13 flex items-center gap-8 px-10 py-8 ${index === 0 ? 'bg-accent-soft text-accent-ink font-medium' : 'text-text-2'}`}
                >
                  <Icon name={item.icon} className="size-16" />
                  {item.label}
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-16 p-16 sm:p-20">
              <span className="text-16 font-semibold">Harbor Knits</span>
              <dl className="grid grid-cols-3 gap-10">
                {TILES.map((tile) => (
                  <div key={tile.label} className="rounded-12 border-line bg-bg border p-12">
                    <dt className="text-12 text-text-3">{tile.label}</dt>
                    <dd className="text-20 mt-4 font-semibold">{tile.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="rounded-12 border-line bg-bg flex flex-col gap-8 border p-12">
                <div className="text-12 text-text-3 flex justify-between">
                  <span>Plan usage this month</span>
                  <span>64%</span>
                </div>
                <div className="bg-surface-2 h-8 overflow-hidden rounded-full">
                  <div className="bg-accent h-full w-[64%] rounded-full" />
                </div>
              </div>
              <div className="rounded-12 border-line bg-bg flex flex-col gap-6 border p-12">
                <span className="text-12 text-text-3">Voice</span>
                <span className="text-13 text-text-2">
                  Warm and brief. Suggest a size by the visitor's usual fit.
                </span>
              </div>
            </div>
          </div>
        </figure>
      </div>
    </section>
  );
}
