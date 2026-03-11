import { parseEnv, resolveWebhookUrl } from './config/env.js';
import { createLogger } from './logging/logger.js';
import { runCollector } from './runtime/collector.js';
import type { CollectorStatus } from './types/domain.js';
import { startHealthServer } from './health/server.js';

async function main() {
  const env = parseEnv();
  const logger = createLogger(env);
  const args = new Set(process.argv.slice(2));
  const runtime = {
    smoke: args.has('--smoke'),
    dryRun: args.has('--dry-run'),
    resync: args.has('--resync')
  };

  const webhookUrl = resolveWebhookUrl(env);

  let healthState: { status: CollectorStatus; updatedAt: string; lastError?: string } = {
    status: 'retrying',
    updatedAt: new Date().toISOString()
  };

  const server = env.HEALTH_ENDPOINT_ENABLED
    ? startHealthServer(env.HEALTH_ENDPOINT_HOST, env.HEALTH_ENDPOINT_PORT, () => healthState, logger)
    : null;

  try {
    const finalState = await runCollector(env, logger, webhookUrl, runtime, (s) => {
      healthState = s;
    });
    logger.info({ finalState }, 'Collector finished');
  } finally {
    server?.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
