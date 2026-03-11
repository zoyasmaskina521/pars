import type pino from 'pino';
import type { Env } from '../config/env.js';
import type { CollectorStatus, RawMessage } from '../types/domain.js';
import { createSession, detectSiteOrChallenge, ensureAuthenticated } from '../auth/browser.js';
import { collectMessagesNetworkFirst } from '../extractor/extractor.js';
import { normalizeRaw } from '../normalize/normalizer.js';
import { StateStore } from '../state/store.js';
import { WebhookClient } from '../delivery/webhook.js';

export interface CollectorState {
  status: CollectorStatus;
  lastError?: string;
  updatedAt: string;
}

function computeBackoffSec(attempt: number, minSec: number, maxSec: number): number {
  return Math.min(maxSec, minSec * 2 ** Math.max(attempt - 1, 0));
}

function fingerprint(raw: RawMessage): string {
  return `${raw.createdAtSource ?? ''}|${raw.messageText.slice(0, 64)}`;
}

export async function runCollector(
  env: Env,
  logger: pino.Logger,
  webhookUrl: string | null,
  runtime: { dryRun: boolean; smoke: boolean; resync: boolean },
  onStateChange?: (s: CollectorState) => void
) {
  const store = new StateStore(env.STATE_DB_PATH);
  const webhook = new WebhookClient(env, logger, webhookUrl, runtime.dryRun);
  const state: CollectorState = { status: 'retrying', updatedAt: new Date().toISOString() };

  const setState = (status: CollectorStatus, lastError?: string) => {
    state.status = status;
    state.lastError = lastError;
    state.updatedAt = new Date().toISOString();
    onStateChange?.({ ...state });
  };

  let running = true;
  const stop = () => {
    running = false;
    logger.info('Shutdown signal received');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let session = await createSession(env, logger);
  let downAttempts = 0;

  while (running) {
    try {
      const siteState = await detectSiteOrChallenge(session.page, env.SITE_URL);
      if (siteState === 'challenge') {
        setState('challenge_detected');
        logger.warn({ status: state.status }, 'Challenge detected; waiting for manual intervention');
        await waitSeconds(env.HEALTH_CHECK_INTERVAL_SEC);
        continue;
      }
      if (siteState === 'down') {
        downAttempts += 1;
        setState('site_down');
        const backoff = computeBackoffSec(downAttempts, env.RECOVERY_MIN_BACKOFF_SEC, env.RECOVERY_MAX_BACKOFF_SEC);
        logger.warn({ status: state.status, backoffSec: backoff }, 'Site is unavailable, entering recovery loop');
        await waitSeconds(Math.max(backoff, env.HEALTH_CHECK_INTERVAL_SEC));
        continue;
      }

      const auth = await ensureAuthenticated(session.page, env, logger);
      if (auth === 'challenge') {
        setState('challenge_detected');
        await waitSeconds(env.HEALTH_CHECK_INTERVAL_SEC);
        continue;
      }
      if (auth === 'auth_expired') {
        setState('auth_expired');
        await waitSeconds(env.RECOVERY_MIN_BACKOFF_SEC);
        continue;
      }

      if (downAttempts > 0) {
        setState('recovered');
      }
      downAttempts = 0;

      const messages = await collectMessagesNetworkFirst(session.page, logger);
      const inbound = messages.filter((m) => m.direction === 'inbound' && m.messageText);

      for (const raw of inbound) {
        const evt = normalizeRaw(raw, env.COLLECTOR_VERSION);
        if (store.isAlreadySent(evt.source_event_id)) continue;

        const cursor = store.getChatCursor(evt.external_chat_id);
        const fp = fingerprint(raw);
        if (!runtime.resync) {
          if (cursor.createdAt && evt.created_at_source < cursor.createdAt) continue;
          if (cursor.createdAt === evt.created_at_source && cursor.fingerprint === fp) continue;
        }

        store.enqueueOutbox(evt);
        store.updateChatCursor(evt.external_chat_id, evt.created_at_source, fp);
      }

      const due = store.dueOutbox(100);
      for (const row of due) {
        const payload = JSON.parse(row.payload);
        const delivered = await webhook.send(payload);
        if (delivered) {
          store.markSent(row.sourceEventId);
          store.removeOutbox(row.id);
          continue;
        }
        const attempts = row.attempts + 1;
        const backoff = computeBackoffSec(attempts, env.RECOVERY_MIN_BACKOFF_SEC, env.RECOVERY_MAX_BACKOFF_SEC);
        const nextIso = new Date(Date.now() + backoff * 1000).toISOString();
        store.rescheduleOutbox(row.id, attempts, nextIso);
      }

      setState('healthy');
      if (runtime.smoke) break;
      await waitSeconds(env.POLL_INTERVAL_SEC);
    } catch (error) {
      setState('degraded', error instanceof Error ? error.message : String(error));
      logger.error({ err: error, status: state.status }, 'Collector loop failure; recreating browser session');
      try {
        await session.context.close();
        await session.browser.close();
      } catch {
        // ignore
      }
      session = await createSession(env, logger);
      await waitSeconds(env.RECOVERY_MIN_BACKOFF_SEC);
    }
  }

  store.close();
  await session.context.close();
  await session.browser.close();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);

  return state;
}

function waitSeconds(sec: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}
