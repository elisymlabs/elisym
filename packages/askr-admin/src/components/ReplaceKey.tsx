import { useState } from 'react';
import { Notice } from './Notice';
import { Section } from './Section';

interface Props {
  onReplaceKey: () => void;
}

/** Replace the secret key (K20): signs out and starts the replacement for this store. */
export function ReplaceKey({ onReplaceKey }: Props) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Section
      title="Secret key"
      description="If someone else may have your secret key, replace it: you make a new one and prove the store is yours through your site. Your products, policies, plan and chat history stay, and the old key stops working."
    >
      {confirming ? (
        <div className="flex flex-col gap-8">
          <Notice tone="warn">
            You will be signed out to make the new key. Have access to your site at hand: you add
            one line to it.
          </Notice>
          <div className="flex gap-8">
            <button type="button" className="btn btn-primary" onClick={onReplaceKey}>
              Continue
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Keep my key
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            Replace my secret key
          </button>
        </div>
      )}
    </Section>
  );
}
