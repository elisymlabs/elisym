/**
 * Stderr-only structured logger for @elisym/mcp. Stdout is reserved
 * for JSON-RPC messages over the MCP stdio transport - anything else
 * written there breaks the protocol. Pino's redact pipeline catches
 * sensitive fields (private keys, customer input) before bytes leave
 * this process, so a call site that accidentally passes the wrong
 * object into `logger.error` cannot leak.
 *
 * Shared redact paths come from `@elisym/sdk` so the plugin, CLI, and
 * MCP stay in lockstep with a single ground truth.
 */
import { DEFAULT_REDACT_PATHS, makeCensor } from '@elisym/sdk';
import pino, { type Logger } from 'pino';

export function createLogger(destination?: pino.DestinationStream): Logger {
  const opts: pino.LoggerOptions = {
    name: 'elisym-mcp',
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: DEFAULT_REDACT_PATHS,
      censor: makeCensor(),
    },
  };
  if (destination) {
    return pino(opts, destination);
  }
  return pino(opts, pino.destination(2));
}

export const logger = createLogger();
