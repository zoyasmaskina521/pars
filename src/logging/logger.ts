import pino from 'pino';
import type { Env } from '../config/env.js';

export function createLogger(env: Env) {
  return pino({
    level: env.LOG_LEVEL,
    base: { service: 'crdtrove-collector', env: env.APP_ENV },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}
