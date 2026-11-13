import { Button } from '../../components/Button';

interface Props {
  /** Why the read failed; empty while it runs. */
  problem: string;
  onRetry: () => void;
}

/** A page whose read has not landed: loading, or why it failed with a way to try again. */
export function NotRead({ problem, onRetry }: Props) {
  if (problem === '') {
    return <p className="text-14 text-text-3">Loading...</p>;
  }
  return (
    <div className="flex flex-col items-start gap-12">
      <p role="alert" className="text-14 text-error">
        {problem}
      </p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}
