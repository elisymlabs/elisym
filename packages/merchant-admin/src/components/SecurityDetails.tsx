import { LOCAL_ADMIN_COMMAND } from '../constants';
import { Code } from './Code';
import { Icon } from './Icon';

/** The finer points of pasting a key into a web page, folded until asked for. */
export function SecurityDetails() {
  return (
    <details id="security-details" className="group rounded-16 border-line bg-surface/60 border">
      <summary className="rounded-16 text-14 hover:text-text text-text-2 flex cursor-pointer list-none items-center justify-between gap-12 px-16 py-12 font-medium [&::-webkit-details-marker]:hidden">
        Security details
        <Icon name="chevron" className="size-16 transition group-open:rotate-90" />
      </summary>
      <ul className="text-13 text-text-2 flex flex-col gap-10 px-16 pb-16 leading-relaxed">
        <li>
          The key stays in this tab’s memory only: never stored, never sent. It decrypts your orders
          and signs you in to your relays. Log out or close the tab when you are done.
        </li>
        <li>
          Browser extensions can read what you type into any page. Use a browser profile without
          extensions you do not trust, or the local admin: <Code>{LOCAL_ADMIN_COMMAND}</Code>.
        </li>
        <li>
          This page’s code is served by elisym on each visit; the local admin runs the version you
          installed.
        </li>
      </ul>
    </details>
  );
}
