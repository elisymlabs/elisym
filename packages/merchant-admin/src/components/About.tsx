import type { ReactNode } from 'react';
import { LOCAL_ADMIN_COMMAND, QUICKSTART_URL } from '../constants';
import { Code } from './Code';
import { CommandLine } from './CommandLine';
import { Icon, type IconName } from './Icon';
import { Section } from './Section';

const NOTES: { icon: IconName; title: string; body: ReactNode }[] = [
  {
    icon: 'receipt',
    title: 'History is what your relays hold',
    body: 'Orders come from your inbox relays: many keep private messages for only about two days. The elisym relay keeps them.',
  },
  {
    icon: 'check',
    title: 'Totals count what your node credited',
    body: (
      <>
        They are what reached your wallet: a credited payment minus its elisym fee. A buyer&apos;s
        claimed total is not money received. Your node&apos;s <Code>orders</Code> command is the
        reference.
      </>
    ),
  },
  {
    icon: 'info',
    title: 'Older orders show less',
    body: 'Orders your node answered before it kept copies of its answers show at most "payment reported".',
  },
];

export function About() {
  return (
    <Section title="About this page" description="How to read what the admin shows.">
      <div className="grid gap-12 md:grid-cols-3">
        {NOTES.map((note) => (
          <div
            key={note.title}
            className="rounded-16 border-line bg-surface flex flex-col gap-8 border p-16"
          >
            <span className="rounded-10 bg-surface-2 text-text-2 grid size-32 place-items-center">
              <Icon name={note.icon} className="size-16" />
            </span>
            <p className="text-14 font-semibold">{note.title}</p>
            <p className="text-13 text-text-2 leading-relaxed">{note.body}</p>
          </div>
        ))}
      </div>
      <div className="rounded-16 border-line bg-surface flex flex-col gap-10 border p-16">
        <p className="text-14 font-semibold">Run the same view on your own machine</p>
        <p className="text-13 text-text-2">
          The local admin runs the version you installed and is served only to this computer.
        </p>
        <CommandLine command={LOCAL_ADMIN_COMMAND} />
        <a
          href={QUICKSTART_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-13 text-text-2 hover:text-text self-start underline underline-offset-2"
        >
          Read the merchant quickstart
        </a>
      </div>
    </Section>
  );
}
