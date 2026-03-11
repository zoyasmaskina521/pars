import { fetch } from 'undici';
import type pino from 'pino';
import type { NormalizedEvent } from '../types/domain.js';
import type { Env } from '../config/env.js';

export class WebhookClient {
  constructor(
    private readonly env: Env,
    private readonly logger: pino.Logger,
    private readonly webhookUrl: string | null,
    private readonly dryRun: boolean
  ) {}

  async send(event: NormalizedEvent): Promise<boolean> {
    if (!this.webhookUrl) {
      this.logger.warn({ sourceEventId: event.source_event_id }, 'Webhook URL is not configured; enqueueing only');
      return false;
    }

    if (this.dryRun) {
      this.logger.info({ payload: event }, 'Dry-run payload');
      return true;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-idempotency-key': event.source_event_id
    };

    if (this.env.N8N_AUTH_HEADER_VALUE) {
      headers[this.env.N8N_AUTH_HEADER_NAME] = this.env.N8N_AUTH_HEADER_VALUE;
    }

    for (let attempt = 1; attempt <= this.env.N8N_RETRY_MAX_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch(this.webhookUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(this.env.N8N_TIMEOUT_MS)
        });
        if (res.status >= 200 && res.status < 300) return true;

        this.logger.warn({ status: res.status, attempt, sourceEventId: event.source_event_id }, 'Webhook returned non-2xx');
      } catch (error) {
        this.logger.warn({ err: error, attempt, sourceEventId: event.source_event_id }, 'Webhook delivery failed');
      }
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 15000)));
    }

    return false;
  }
}
