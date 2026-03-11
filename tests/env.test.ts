import { describe, expect, it } from 'vitest';
import { resolveWebhookUrl } from '../src/config/env.js';

describe('env helpers', () => {
  it('resolves env specific webhook', () => {
    const url = resolveWebhookUrl({
      APP_ENV: 'prod',
      N8N_WEBHOOK_URL: undefined,
      N8N_WEBHOOK_URL_PROD: 'https://prod.example/webhook',
      N8N_WEBHOOK_URL_DEV: 'https://dev.example/webhook'
    } as any);

    expect(url).toBe('https://prod.example/webhook');
  });
});
