/**
 * The one failure type of the `askr` commands: an exit code from the
 * documented table, a stable `code`, and fields built from codes and values,
 * never from objects holding keys. `message` carries text a server or relay
 * sent; `hint` is ours.
 */
export const EXIT = {
  OK: 0,
  BAD_INPUT: 1,
  KEY: 2,
  REFUSED: 3,
  NOT_DONE: 4,
  LIMIT: 5,
  EXISTING_STORE: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface AskrExitOptions {
  hint?: string;
  /** Text from the server or the relay, kept apart from our own hint. */
  message?: string;
  /** Extra top-level fields of the JSON output (`resume`, `retryAfterSeconds`, ...). */
  fields?: Record<string, unknown>;
}

export class AskrExit extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly hint: string | undefined;
  readonly serverMessage: string | undefined;
  readonly fields: Record<string, unknown>;

  constructor(exitCode: ExitCode, code: string, options: AskrExitOptions = {}) {
    super(code);
    this.name = 'AskrExit';
    this.exitCode = exitCode;
    this.code = code;
    this.hint = options.hint;
    this.serverMessage = options.message;
    this.fields = options.fields ?? {};
  }
}

/** What a command prints and exits with. */
export interface CommandOutcome {
  exitCode: ExitCode;
  output: Record<string, unknown>;
}

/** A failure as its JSON object: `ok: false`, the error, then its fields. */
export function outcomeOfExit(failure: AskrExit): CommandOutcome {
  const error: Record<string, string> = { code: failure.code };
  if (failure.hint !== undefined) {
    error.hint = failure.hint;
  }
  if (failure.serverMessage !== undefined) {
    error.message = failure.serverMessage;
  }
  return { exitCode: failure.exitCode, output: { ok: false, error, ...failure.fields } };
}
