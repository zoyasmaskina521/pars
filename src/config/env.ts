import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const EnvSchema = z.object({
  APP_ENV: z.enum(['dev', 'prod']).default('dev'),
  LOG_LEVEL: z.enum(['debug', 'info']).default('info'),
  SITE_URL: z.string().url().default('https://crdtrove.com/'),
  CRDTROVE_LOGIN: z.string().min(1),
  CRDTROVE_PASSWORD: z.string().min(1),
  SESSION_STATE_PATH: z.string().default('./data/session-state.json'),
  STATE_DB_PATH: z.string().default('./data/collector.db'),
  PROXY_SERVER: z.string().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),
  CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
  HEADLESS: z.string().default('true').transform((v) => v === 'true'),
  DIAGNOSTIC_HEADFUL: z.string().default('false').transform((v) => v === 'true'),
  POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(120),
  HEALTH_CHECK_INTERVAL_SEC: z.coerce.number().int().positive().default(600),
  RECOVERY_MIN_BACKOFF_SEC: z.coerce.number().int().positive().default(15),
  RECOVERY_MAX_BACKOFF_SEC: z.coerce.number().int().positive().default(600),
  NAV_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  AUTH_FORM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  POST_LOGIN_SETTLE_MS: z.coerce.number().int().positive().default(3000),
  BOOTSTRAP_TIMEOUT_SEC: z.coerce.number().int().positive().default(900),
  BOOTSTRAP_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  N8N_WEBHOOK_URL: z.string().url().optional(),
  N8N_WEBHOOK_URL_DEV: z.string().url().optional(),
  N8N_WEBHOOK_URL_PROD: z.string().url().optional(),
  N8N_AUTH_HEADER_NAME: z.string().default('Authorization'),
  N8N_AUTH_HEADER_VALUE: z.string().optional(),
  N8N_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  N8N_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  HEALTH_ENDPOINT_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  HEALTH_ENDPOINT_HOST: z.string().default('127.0.0.1'),
  HEALTH_ENDPOINT_PORT: z.coerce.number().int().positive().default(8080),
  RESYNC_LOOKBACK_MESSAGES: z.coerce.number().int().positive().default(30),
  COLLECTOR_VERSION: z.string().default('0.1.0')
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issue = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issue}`);
  }
  return parsed.data;
}

export function resolveWebhookUrl(env: Env): string | null {
  if (env.N8N_WEBHOOK_URL) return env.N8N_WEBHOOK_URL;
  if (env.APP_ENV === 'prod') return env.N8N_WEBHOOK_URL_PROD ?? null;
  return env.N8N_WEBHOOK_URL_DEV ?? null;
}
