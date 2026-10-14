import { type ReactNode, useRef, useState } from 'react';
import { LOCAL_ADMIN_COMMAND, QUICKSTART_URL, STORE_KEY_COMMAND } from '../constants';
import { type StoreKey, parseStoreKey } from '../lib/core';
import { AuthLayout } from './AuthLayout';
import { Code } from './Code';
import { CommandLine } from './CommandLine';
import { Icon, type IconName } from './Icon';

interface Props {
  onKey: (key: StoreKey) => void;
}

const NOTES: { icon: IconName; title: string; body: ReactNode }[] = [
  {
    icon: 'lock',
    title: 'Kept in this tab only',
    body: 'The key stays in this tab’s memory: never stored, never sent. It only decrypts your orders and signs in to your relays. Log out or close the tab when you are done.',
  },
  {
    icon: 'eye',
    title: 'Extensions can read it',
    body: (
      <>
        Browser extensions see what you type into any page. Use a profile without extensions you do
        not trust, or the local admin: <Code>{LOCAL_ADMIN_COMMAND}</Code>.
      </>
    ),
  },
  {
    icon: 'alert',
    title: 'It controls your store',
    body: 'Anyone with this key can redirect payments from new buyers. This page’s code is served by elisym on each visit; the local admin runs the version you installed.',
  },
];

/** The key field: a masked text field outside any form, read once and cleared. */
export function SignIn({ onKey }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  const submit = () => {
    const field = input.current;
    if (field === null) {
      return;
    }
    const key = parseStoreKey(field.value);
    field.value = '';
    if (key === undefined) {
      setError('That is not a secret key: paste an nsec or 64 hex characters.');
      return;
    }
    setError('');
    onKey(key);
  };

  return (
    <AuthLayout>
      <div className="grid w-full max-w-960 gap-24 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-20 border-line bg-surface border p-24 shadow-sm sm:p-32">
          <h1 className="text-24 font-semibold tracking-tight">Sign in to your store</h1>
          <p className="text-15 text-text-2 mt-8">
            See your orders, what your node credited, your products and your store profile, read
            straight from your relays.
          </p>

          <ol className="mt-28 flex flex-col gap-20">
            <li className="flex gap-12">
              <span className="bg-surface-2 text-13 grid size-24 shrink-0 place-items-center rounded-full font-semibold">
                1
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-8">
                <p className="text-14 font-medium">
                  On the machine that runs your node, print the store key
                </p>
                <CommandLine command={STORE_KEY_COMMAND} />
              </div>
            </li>
            <li className="flex gap-12">
              <span className="bg-surface-2 text-13 grid size-24 shrink-0 place-items-center rounded-full font-semibold">
                2
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-8">
                <label htmlFor="store-key" className="text-14 font-medium">
                  Paste it here
                </label>
                <input
                  id="store-key"
                  ref={input}
                  className="masked placeholder:text-text-3 rounded-10 border-line-2 bg-bg text-14 focus:border-accent-ink focus:ring-accent-soft min-w-0 border px-12 py-10 font-mono outline-none focus:ring-4"
                  type="text"
                  placeholder="nsec1... or 64 hex characters"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-describedby="store-key-error"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      submit();
                    }
                  }}
                />
                <p
                  id="store-key-error"
                  role="alert"
                  className="text-13 text-error min-h-18 empty:min-h-0"
                >
                  {error}
                </p>
              </div>
            </li>
          </ol>

          <button
            type="button"
            onClick={submit}
            className="rounded-10 bg-ink text-15 text-ink-text mt-8 w-full py-12 font-semibold transition hover:opacity-90"
          >
            Open store
          </button>
          <p className="text-13 text-text-3 mt-16 text-center">
            No store yet?{' '}
            <a
              href={QUICKSTART_URL}
              rel="noopener noreferrer"
              className="text-text-2 hover:text-text underline underline-offset-2"
            >
              Start one in the quickstart
            </a>
          </p>
        </div>

        <aside className="flex flex-col gap-12">
          <p className="text-12 text-text-3 px-4 font-semibold tracking-wide uppercase">
            Before you paste
          </p>
          {NOTES.map((note) => (
            <div
              key={note.title}
              className="rounded-16 border-line bg-surface/60 flex gap-12 border p-16"
            >
              <span className="rounded-10 bg-surface-2 text-text-2 grid size-32 shrink-0 place-items-center">
                <Icon name={note.icon} className="size-16" />
              </span>
              <div className="flex min-w-0 flex-col gap-4">
                <p className="text-14 font-semibold">{note.title}</p>
                <p className="text-13 text-text-2 leading-relaxed">{note.body}</p>
              </div>
            </div>
          ))}
        </aside>
      </div>
    </AuthLayout>
  );
}
