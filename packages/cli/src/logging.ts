/**
 * Structured logger for the CLI. Stdout stays reserved for the
 * human-readable banner (rendered via `logWithIndent`). Diagnostic
 * output - incoming events, relay lifecycle, publish acks, watchdog
 * decisions - goes to stderr as JSON by default, or pretty-printed
 * when the process is attached to a TTY and pino-pretty is available.
 *
 * Redaction uses the SDK's DEFAULT_REDACT_PATHS so secret keys and
 * user input cannot leak through structured logs even in verbose mode.
 */
import { DEFAULT_REDACT_PATHS, makeCensor } from '@elisym/sdk';
import pino, { type Logger } from 'pino';

export interface CreateLoggerOptions {
  /** When true, set level to 'debug' and emit the debug firehose. */
  verbose?: boolean;
  /** When true, pretty-print to stderr; otherwise raw JSON to stderr. */
  tty?: boolean;
  /** Override the log level directly (takes precedence over verbose). */
  level?: string;
  /** Escape hatch for tests: redirect structured output to an explicit stream. */
  destination?: pino.DestinationStream;
}

export interface CliLogger {
  logger: Logger;
  /** Pretty 2-space-indented write to stdout, used by the startup banner. */
  logWithIndent(line: string): void;
  /** Banner-only write to stdout. Semantically identical to logWithIndent. */
  bannerLog(line: string): void;
}

function resolveLevel(options: CreateLoggerOptions): string {
  if (options.level) {
    return options.level;
  }
  if (options.verbose) {
    return 'debug';
  }
  const envLevel = process.env.LOG_LEVEL;
  if (envLevel) {
    return envLevel;
  }
  return 'info';
}

export function createLogger(options: CreateLoggerOptions = {}): CliLogger {
  const level = resolveLevel(options);
  const baseOptions: pino.LoggerOptions = {
    name: 'elisym-cli',
    level,
    redact: {
      paths: DEFAULT_REDACT_PATHS,
      censor: makeCensor(),
    },
  };

  let logger: Logger;
  if (options.destination) {
    logger = pino(baseOptions, options.destination);
  } else if (options.tty === true) {
    logger = pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: { destination: 2, colorize: true, translateTime: 'HH:MM:ss' },
      },
    });
  } else {
    // Raw JSON to stderr (fd 2) so stdout stays clean for the banner.
    logger = pino(baseOptions, pino.destination(2));
  }

  function logWithIndent(line: string): void {
    process.stdout.write(`  ${line}\n`);
  }

  return {
    logger,
    logWithIndent,
    bannerLog: logWithIndent,
  };
}
