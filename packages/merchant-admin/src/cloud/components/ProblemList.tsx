import type { ProblemText } from '../lib/problems';

interface Props {
  problems: readonly ProblemText[];
  /** For the field it is about: its `aria-describedby` names this list. */
  id?: string;
}

/** Refusals in words, each with the line as it came folded under Details (for support). */
export function ProblemList({ problems, id }: Props) {
  if (problems.length === 0) {
    return null;
  }
  return (
    <ul
      {...(id === undefined ? {} : { id })}
      role="alert"
      className="text-13 text-error flex flex-col gap-4"
    >
      {problems.map((problem, index) => (
        <li key={`${index}-${problem.raw}`} data-problem-field={problem.field ?? 'store'}>
          <span>{problem.text}</span>
          {problem.raw === problem.text ? null : (
            <details className="text-12 text-text-3 mt-2">
              <summary className="cursor-pointer">Details</summary>
              <span className="font-mono break-all">{problem.raw}</span>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}
