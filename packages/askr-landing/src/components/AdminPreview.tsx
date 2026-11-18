import { BUTTON } from '../buttons';
import { PRODUCT_NAME } from '../constants';
import { AdminLink } from './AdminLink';
import { AdminWindow } from './AdminWindow';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Reveal } from './Reveal';

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
    <section id="admin" className="mx-auto max-w-1440 px-16 py-96 sm:px-24 sm:py-160">
      <div className="grid items-center gap-56 lg:grid-cols-[0.6fr_1.4fr]">
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
          <AdminWindow />
        </Reveal>
      </div>
    </section>
  );
}
