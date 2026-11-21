import { AI_AGENTS_DOCS_URL } from '../constants';
import { HELP } from '../lib/help';
import { siteLlmsTxt, storeLlmsTxtUrl } from '../lib/llms-txt';
import type { StoreStatus } from '../lib/types';
import { CopyBlock } from './CopyBlock';
import { Section } from './Section';

interface Props {
  npub: string;
  /** The published store name; empty before the settings are published. */
  storeName: string;
  status: StoreStatus;
}

/**
 * The `llms.txt` for the merchant's site root: it tells an AI agent the store
 * uses Askr and links to the store's own files on the server, which agents
 * read without a chat (no budget spent).
 */
export function LlmsTxtSection({ npub, storeName, status }: Props) {
  const url = storeLlmsTxtUrl(npub);
  return (
    <Section
      title="llms.txt for AI agents"
      info={HELP.llmsTxt}
      description="Save this as llms.txt at your site's root, so it opens at your site's address followed by /llms.txt. AI agents that visit your site then learn your store uses Askr and read your products and policies without opening the chat, so they use none of its budget. If your site already has an llms.txt, add the Shopping assistant part to its end."
    >
      <CopyBlock label="llms.txt" text={siteLlmsTxt(npub, storeName)} />
      <p className="text-13 text-text-2 break-all">
        Your store&apos;s full file for agents:{' '}
        <a
          className="hover:text-text underline underline-offset-2"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          {url}
        </a>
        {status === 'active' ? '' : ' (it answers once your store is active)'}
      </p>
      <a
        className="text-13 text-text-2 hover:text-text self-start underline underline-offset-2"
        href={AI_AGENTS_DOCS_URL}
        target="_blank"
        rel="noreferrer"
      >
        More on AI agents and your store
      </a>
    </Section>
  );
}
