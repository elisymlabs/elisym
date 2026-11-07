import { CopyButton } from '../../components/CopyButton';
import { Section } from '../../components/Section';
import { CONTACT_URL } from '../../constants';

interface Props {
  tenantId: string;
}

const PAGES: { name: string; text: string }[] = [
  { name: 'Overview', text: 'how the store stands, what it sold, and its latest orders.' },
  { name: 'Orders', text: 'every order, the ones waiting for your answer, and the CSV.' },
  { name: 'Products', text: 'what the store sells: add, edit, take off sale.' },
  { name: 'Payouts', text: 'the wallets buyers pay, signed with your access key.' },
  {
    name: 'Install',
    text: 'the snippet to paste into your site: a script and a button per product.',
  },
  { name: 'Settings', text: 'name, domain, webhook, taking the store off sale, and export.' },
  { name: 'Plan & billing', text: 'your plan and paying for it.' },
];

/** The cloud store's Help: what each page does, the access key, and how to reach us. */
export function CloudAbout({ tenantId }: Props) {
  return (
    <Section title="Help" heading="h1" description="What each page does, and how to reach us.">
      <ul className="text-14 text-text-2 flex flex-col gap-8">
        {PAGES.map((page) => (
          <li key={page.name}>
            <span className="text-text font-medium">{page.name}</span>: {page.text}
          </li>
        ))}
      </ul>
      <p className="text-14 text-text-2">
        Your access key is your password for this admin: it stays in this tab and we never see it.
        Keep its file safe; we cannot restore it.
      </p>
      <p className="text-13 text-text-3 flex items-center gap-4">
        Store id <span className="font-mono">{tenantId}</span>
        <CopyButton text={tenantId} label="Copy the store id" />
      </p>
      <p className="text-14 text-text-2">
        Questions?{' '}
        <a
          href={CONTACT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-text underline underline-offset-2"
        >
          Talk to us
        </a>
        .
      </p>
    </Section>
  );
}
