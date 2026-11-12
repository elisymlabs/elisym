import type { StoreConfig } from '@elisym/askr';
import { cspSources, elementSnippet, scriptSnippet } from '../lib/embed';
import { npubOf } from '../lib/signer';
import { CopyBlock } from './CopyBlock';
import { Section } from './Section';

interface Props {
  owner: string;
  config: StoreConfig | undefined;
}

/** The embed code and the CSP sources a host page must allow (6). */
export function EmbedSection({ owner, config }: Props) {
  const npub = npubOf(owner);
  return (
    <div className="flex flex-col gap-16">
      <Section
        title="Add the chat to your site"
        description="Paste this before the closing body tag on every page that should show the chat."
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
