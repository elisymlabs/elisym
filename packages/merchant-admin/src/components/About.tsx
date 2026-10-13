import { LOCAL_ADMIN_COMMAND } from '../constants';
import { Code } from './Code';
import { Section } from './Section';

export function About() {
  return (
    <Section title="About this page">
      <ul className="text-14 text-text-2 flex list-disc flex-col gap-6 pl-20">
        <li>
          History is what your inbox relays still hold: many keep private messages for only about
          two days. The elisym relay keeps them.
        </li>
        <li>
          Orders your node answered before it kept copies of its answers show at most &quot;payment
          reported&quot;.
        </li>
        <li>
          Totals count only what your node credited. Your node&apos;s <Code>orders</Code> command is
          the reference.
        </li>
        <li>
          The same view runs on your own machine: <Code>{LOCAL_ADMIN_COMMAND}</Code>.
        </li>
      </ul>
    </Section>
  );
}
