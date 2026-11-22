import { useState } from 'react';
import { keyFileName, keyFileText, saveTextFile } from '../lib/key-file';

interface Props {
  nsec: string;
  npub: string;
}

/** Save the secret key and Store ID as a small text file, made in this tab. */
export function DownloadKey({ nsec, npub }: Props) {
  const [savedAs, setSavedAs] = useState('');
  const download = () => {
    const name = keyFileName(npub);
    saveTextFile(name, keyFileText(nsec, npub));
    setSavedAs(name);
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <button type="button" className="btn" onClick={download}>
          Download key file
        </button>
      </div>
      {savedAs === '' ? null : (
        <p className="text-13 text-text-2">
          Saved as {savedAs}. Keep the file private: whoever has it controls your Askr assistant.
        </p>
      )}
    </div>
  );
}
