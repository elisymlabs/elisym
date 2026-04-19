import {
  DEFAULT_REDACT_PATHS,
  INPUT_REDACT_PATHS,
  SECRET_REDACT_PATHS,
  makeCensor,
} from '@elisym/sdk';
import pino from 'pino';

export { DEFAULT_REDACT_PATHS, INPUT_REDACT_PATHS, SECRET_REDACT_PATHS };

export const logger = pino({
  name: 'elisym-plugin',
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: DEFAULT_REDACT_PATHS,
    censor: makeCensor(),
  },
});
