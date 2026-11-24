import { useState } from 'react';
import { downloadText } from '../../lib/download';
import { keyFileName, keyFileText } from '../lib/key-file';
import { BUTTON_SECONDARY } from '../styles';

interface Props {
  nsec: string;
  npub: string;
}

/** Save the owner key and its Owner ID as a small text file, made in this tab. */
export function DownloadKey({ nsec, npub }: Props) {
  const [savedAs, setSavedAs] = useState('');
  const download = () => {
    const name = keyFileName(npub);
    const adminUrl = `${window.location.origin}/hosted/`;
    downloadText(document, keyFileText(nsec, npub, adminUrl), name, 'text/plain;charset=utf-8');
    setSavedAs(name);
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <button type="button" className={BUTTON_SECONDARY} onClick={download}>
          Download key file
        </button>
      </div>
      {savedAs === '' ? null : (
        <p className="text-13 text-text-2">
          Saved as {savedAs}. Keep the file private: whoever has it controls your store.
        </p>
      )}
    </div>
  );
}
