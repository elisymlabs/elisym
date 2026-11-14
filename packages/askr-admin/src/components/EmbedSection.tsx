import type { StoreConfig } from '@elisym/askr';
import { useEffect, useState } from 'react';
import type { AdminClient } from '../lib/deps';
import { cspSources, elementSnippet, pinnedScriptSnippet, scriptSnippet } from '../lib/embed';
import { npubOf } from '../lib/signer';
import type { PinnedWidget } from '../lib/types';
import { CopyBlock } from './CopyBlock';
import { Notice } from './Notice';
import { Section } from './Section';

interface Props {
  api: Pick<AdminClient, 'pinnedWidget'>;
  owner: string;
  config: StoreConfig | undefined;
}

type PinnedLoad =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; widget: PinnedWidget };

/** The embed code, auto-updating and pinned, and the CSP sources a host page must allow (6). */
export function EmbedSection({ api, owner, config }: Props) {
  const npub = npubOf(owner);
  const [pinned, setPinned] = useState<PinnedLoad>({ state: 'loading' });

  useEffect(() => {
    let current = true;
    api.pinnedWidget().then(
      (widget) => {
        if (current) {
          setPinned({ state: 'ready', widget });
        }
      },
      () => {
        if (current) {
          setPinned({ state: 'failed' });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  let pinnedContent;
  if (pinned.state === 'ready') {
    pinnedContent = (
      <CopyBlock label="Pinned embed code" text={pinnedScriptSnippet(npub, pinned.widget)} />
    );
  } else if (pinned.state === 'failed') {
    pinnedContent = (
      <Notice tone="warn">The pinned version could not be read. Refresh to try again.</Notice>
    );
  } else {
    pinnedContent = <p className="text-14 text-text-2">Reading the current version...</p>;
  }

  return (
    <div className="flex flex-col gap-16">
      <Section
        title="Add the chat to your site"
        description="Paste this before the closing body tag on every page that should show the chat. It always loads the current version, so fixes reach your site within minutes."
      >
        <CopyBlock label="Embed code" text={scriptSnippet(npub)} />
        <CopyBlock label="Or place the chat element yourself" text={elementSnippet(npub)} />
        <p className="text-13 text-text-2">
          Add data-theme="light" or data-theme="dark" to the script tag to fix the theme. The chat
          answers only on your allowed origins
          {config === undefined ? '' : `: ${config.origins.join(', ')}`}.
        </p>
      </Section>
      <Section
        title="Pin one version"
        description="This loads one exact version of the chat, and the browser runs it only if it matches its integrity hash, so it never changes under you. Fixes and new features do not reach it: paste a newer snippet from here to update."
      >
        {pinnedContent}
      </Section>
      <Section
        title="Content Security Policy"
        description="If your site sends a Content-Security-Policy header, add these sources to it."
      >
        <table className="text-14 w-full">
          <tbody>
            {cspSources().map((source) => (
              <tr key={source.directive} className="border-line border-t align-top">
                <td className="py-6 pr-12 font-mono whitespace-nowrap">{source.directive}</td>
                <td className="py-6 pr-12 font-mono break-all">{source.sources.join(' ')}</td>
                <td className="text-text-2 py-6">{source.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
