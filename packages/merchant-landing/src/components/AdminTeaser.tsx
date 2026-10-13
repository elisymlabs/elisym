import { LOCAL_ADMIN_COMMAND, PRODUCT_NAME } from '../constants';
import { Icon, type IconName } from './Icon';
import { SectionHeading } from './SectionHeading';
import { SignInLink } from './SignInLink';

const FEATURES: { icon: IconName; text: string }[] = [
  { icon: 'table', text: 'Every order and its state, read from your inbox relays' },
  { icon: 'bolt', text: 'What your node credited, per coin, with explorer links' },
  { icon: 'code', text: 'All your products and your store profile' },
  { icon: 'check', text: 'A CSV for your books' },
];

export function AdminTeaser() {
  return (
    <section id="admin" className="border-line bg-surface border-y">
      <div className="mx-auto grid max-w-1160 items-center gap-48 px-16 py-80 sm:px-24 sm:py-112 lg:grid-cols-2">
        <div className="flex flex-col gap-28">
          <SectionHeading eyebrow={`${PRODUCT_NAME} admin`} title="Your orders, in your browser">
            Sign in with your store key and see your store the way your node does. Nothing to
            install, no account to create.
          </SectionHeading>
          <ul className="grid gap-12 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <li key={feature.text} className="text-15 flex gap-10">
                <span className="text-accent-ink mt-2 shrink-0">
                  <Icon name={feature.icon} className="size-18" />
                </span>
                {feature.text}
              </li>
            ))}
          </ul>
          <SignInLink
            label="Open the admin"
            className="rounded-12 bg-accent text-15 text-accent-text self-start px-20 py-12 font-semibold transition hover:brightness-95"
          />
        </div>
        <div className="rounded-20 border-line bg-bg flex flex-col gap-16 border p-24">
          <div className="flex items-center gap-12">
            <span className="rounded-12 bg-accent-soft text-accent-ink grid size-40 place-items-center">
              <Icon name="lock" />
            </span>
            <h3 className="text-18 font-semibold">Your key stays with you</h3>
          </div>
          <p className="text-15 text-text-2 leading-relaxed">
            The admin runs on its own domain and reads your relays directly. The key lives only in
            that tab&apos;s memory: it is never stored and never sent anywhere.
          </p>
          <p className="text-15 text-text-2 leading-relaxed">
            Browser extensions can read what you type into any page. Use a browser profile without
            extensions you do not trust, or run the same admin on your own machine:
          </p>
          <code
            title={LOCAL_ADMIN_COMMAND}
            className="rounded-12 border-line bg-surface text-13 border px-12 py-10 font-mono break-all"
          >
            {LOCAL_ADMIN_COMMAND}
          </code>
        </div>
      </div>
    </section>
  );
}
