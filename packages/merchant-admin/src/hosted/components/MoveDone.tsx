import type { Ref } from 'react';
import type { StoreView } from '../lib/types';
import { BUTTON_PRIMARY } from '../styles';
import { DomainGuide } from './DomainGuide';
import { Notice } from './Notice';
import { type RememberHandle, RememberOption } from './RememberOption';

interface Props {
  /** The store as it was read before the move. */
  view: StoreView;
  /** The new owner key O', hex. */
  newOwner: string;
  /** What came of the store's setup request, in a sentence. */
  message: string;
  tone: 'info' | 'error';
  /** The domain names O: show the file for O'. */
  domainUpdate: boolean;
  rememberRef: Ref<RememberHandle>;
  /** Remembering the new key is at work. */
  busy: boolean;
  problem: string | undefined;
  onContinue: () => void;
}

export const MOVED_TITLE = 'Your store moved to the new owner key';
export const DOMAIN_NOW =
  'Now update your domain: serve this file in place of the one that names your previous owner key.';

/** After the move: what is left to do, then the page goes on signed in with the new key. */
export function MoveDone({
  view,
  newOwner,
  message,
  tone,
  domainUpdate,
  rememberRef,
  busy,
  problem,
  onContinue,
}: Props) {
  return (
    <div className="flex flex-col gap-12" id="move-done">
      <h3 className="text-15 font-semibold">{MOVED_TITLE}</h3>
      <Notice tone={tone}>{message}</Notice>
      {domainUpdate ? (
        <div className="flex flex-col gap-8">
          <Notice tone="warn">{DOMAIN_NOW}</Notice>
          <DomainGuide view={{ ...view, owner: newOwner }} nip05={view.config?.nip05} />
        </div>
      ) : null}
      <RememberOption ref={rememberRef} id="move-key" label="Remember the new key on this device" />
      {problem === undefined ? null : <Notice tone="error">{problem}</Notice>}
      <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={onContinue}>
        {busy ? 'Saving on this device...' : 'Continue with the new key'}
      </button>
    </div>
  );
}
