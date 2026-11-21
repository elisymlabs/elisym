/**
 * The `askr` wrapper (5.0): `@elisym/askr` loaded first (dynamic import only,
 * so no other CLI command ever loads it), the Node check, one session with
 * its deadline, the command module loaded on demand, every failure turned
 * into the one JSON object, and the exit only once that line is flushed.
 */
import type * as AskrModule from '@elisym/askr';
import { CommanderError } from 'commander';
import { AskrExit, type CommandOutcome, EXIT, type ExitCode, outcomeOfExit } from './errors';
import type { InitOptions } from './init';
import { profileOf } from './owner-key';
import type { PolicyOptions } from './policy';
import type { ProductsOptions } from './products';
import { type AskrDeps, Session, defaultDeps } from './session';
import type { StatusOptions } from './status';

export const loadAskr = (): Promise<typeof AskrModule> => import('@elisym/askr');

export type AskrInvocation =
  | { command: 'init'; options: InitOptions }
  | { command: 'plan'; plan: string }
  | { command: 'products'; options: ProductsOptions }
  | { command: 'policy'; options: PolicyOptions }
  | { command: 'connector' }
  | { command: 'status'; options: StatusOptions }
  | { command: 'embed' }
  | { command: 'export-key'; out: string };

export interface InvocationContext {
  profile?: string;
  /** What was typed after `askr`: the line a `resume` repeats. */
  args: readonly string[];
}

export interface RunnerIo {
  write: (line: string, flushed: () => void) => void;
  exit: (code: number) => void;
}

export interface RunnerHooks {
  loadAskr: () => Promise<typeof AskrModule>;
  deps: (askr: typeof AskrModule) => AskrDeps;
  io: RunnerIo;
  hasWebSocket: () => boolean;
}

export const PROCESS_IO: RunnerIo = {
  write: (line, flushed) => {
    process.stdout.write(line, () => flushed());
  },
  exit: (code) => process.exit(code),
};

const DEFAULT_HOOKS: RunnerHooks = {
  loadAskr,
  deps: defaultDeps,
  io: PROCESS_IO,
  hasWebSocket: () => 'WebSocket' in globalThis,
};

/** One JSON line, then the exit with its code, only once the line is written. */
export function emit(outcome: CommandOutcome, io: RunnerIo): void {
  io.write(`${JSON.stringify(outcome.output)}\n`, () => io.exit(outcome.exitCode));
}

function outcomeOf(error: unknown): CommandOutcome {
  if (error instanceof AskrExit) {
    return outcomeOfExit(error);
  }
  // Never the error's text: an unexpected object could hold anything.
  return outcomeOfExit(
    new AskrExit(EXIT.BAD_INPUT, 'unexpected', {
      hint: 'an unexpected error: run the command again, or report it',
      fields: { name: error instanceof Error ? error.name : typeof error },
    }),
  );
}

async function dispatch(session: Session, invocation: AskrInvocation): Promise<CommandOutcome> {
  switch (invocation.command) {
    case 'init': {
      const { runInit } = await import('./init');
      return runInit(session, invocation.options);
    }
    case 'plan': {
      const { runPlan } = await import('./plan');
      return runPlan(session, invocation.plan);
    }
    case 'products': {
      const { runProducts } = await import('./products');
      return runProducts(session, invocation.options);
    }
    case 'policy': {
      const { runPolicy } = await import('./policy');
      return runPolicy(session, invocation.options);
    }
    case 'connector': {
      const { runConnector } = await import('./connector');
      return runConnector(session);
    }
    case 'status': {
      const { runStatus } = await import('./status');
      return runStatus(session, invocation.options);
    }
    case 'embed': {
      const { runEmbed } = await import('./embed');
      return runEmbed(session);
    }
    case 'export-key': {
      const { runExportKey } = await import('./export-key');
      return runExportKey(session, invocation.out);
    }
  }
}

/** Run one `askr` command and print its outcome; returns the outcome for tests. */
export async function runAskrCommand(
  invocation: AskrInvocation,
  context: InvocationContext,
  hooks: RunnerHooks = DEFAULT_HOOKS,
): Promise<CommandOutcome> {
  let session: Session | undefined;
  let outcome: CommandOutcome;
  try {
    let askr: typeof AskrModule;
    try {
      askr = await hooks.loadAskr();
    } catch {
      throw new AskrExit(EXIT.BAD_INPUT, 'askr_unavailable', {
        hint: 'the @elisym/askr package cannot be loaded: reinstall the CLI (npx -y @elisym/cli@latest)',
      });
    }
    if (!hooks.hasWebSocket()) {
      throw new AskrExit(EXIT.BAD_INPUT, 'node_version', {
        hint: 'Askr commands need Node 22 or newer',
      });
    }
    session = new Session({
      askr,
      deps: hooks.deps(askr),
      profile: profileOf(context.profile),
      args: context.args,
    });
    outcome = await dispatch(session, invocation);
  } catch (error) {
    outcome = outcomeOf(error);
  } finally {
    session?.close();
  }
  emit(outcome, hooks.io);
  return outcome;
}

const ZERO_EXIT_CODES = new Set(['commander.helpDisplayed', 'commander.version']);

/** A commander parse failure of an `askr` line as the JSON error; help and version exit 0. */
export function emitParseError(error: unknown, io: RunnerIo = PROCESS_IO): void {
  // Help and version (also `askr help [command]`) end with exit code 0: printed, nothing failed.
  if (
    error instanceof CommanderError &&
    (error.exitCode === 0 || ZERO_EXIT_CODES.has(error.code))
  ) {
    io.exit(EXIT.OK);
    return;
  }
  const exitCode: ExitCode = EXIT.BAD_INPUT;
  const outcome =
    error instanceof CommanderError
      ? outcomeOfExit(
          new AskrExit(exitCode, 'bad_flag', {
            hint:
              error.code === 'commander.help'
                ? 'name a command: init, plan, products, policy, connector, status, embed, export-key'
                : 'run askr <command> --help for its flags',
            ...(error.code === 'commander.help' ? {} : { message: error.message }),
          }),
        )
      : outcomeOf(error);
  emit(outcome, io);
}
