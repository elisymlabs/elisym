import { Notice } from './Notice';

interface Props {
  error: string;
  onRetry: () => Promise<void>;
}

/** The published settings could not be read: nothing that would replace them is offered. */
export function ConfigUnreadable({ error, onRetry }: Props) {
  return (
    <div className="flex flex-col gap-8">
      <Notice tone="error">
        {error} Your settings cannot be changed until they are read, so a save does not replace them
        by mistake.
      </Notice>
      <div>
        <button type="button" className="btn" onClick={() => void onRetry()}>
          Retry
        </button>
      </div>
    </div>
  );
}
