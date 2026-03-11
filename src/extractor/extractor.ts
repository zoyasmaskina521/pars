import crypto from 'node:crypto';
import type { Page, Response } from 'playwright';
import type pino from 'pino';
import type { RawMessage } from '../types/domain.js';

function safeIso(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function syntheticFromPayload(payload: Record<string, unknown>, source: 'network' | 'dom'): RawMessage | null {
  const text = typeof payload.messageText === 'string' ? payload.messageText : typeof payload.text === 'string' ? payload.text : null;
  const direction = typeof payload.direction === 'string' ? payload.direction : 'inbound';
  if (!text) return null;

  return {
    externalChatId: String(payload.chatId ?? payload.externalChatId ?? payload.conversationId ?? 'unknown-chat'),
    externalBuyerId: String(payload.buyerId ?? payload.externalBuyerId ?? payload.senderId ?? 'unknown-buyer'),
    itemTitle: (payload.itemTitle as string | null) ?? null,
    listedPrice: (payload.listedPrice as string | null) ?? null,
    currency: (payload.currency as string | null) ?? null,
    messageText: normalizeText(text),
    createdAtSource: safeIso(payload.createdAt ?? payload.timestamp ?? Date.now()),
    sourceMessageId: (payload.messageId as string | null) ?? null,
    externalItemKey: (payload.itemKey as string | null) ?? null,
    source,
    direction: direction === 'outbound' || direction === 'system' ? direction : 'inbound',
    ordinalHint: typeof payload.ordinal === 'number' ? payload.ordinal : undefined
  };
}

function tryParseMessageList(json: unknown): RawMessage[] {
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  const arrCandidates = [obj.messages, obj.items, obj.data].filter(Array.isArray) as unknown[][];
  const arr = arrCandidates[0];
  if (!arr) {
    const single = syntheticFromPayload(obj, 'network');
    return single ? [single] : [];
  }

  return arr
    .map((m, idx) => {
      if (!m || typeof m !== 'object') return null;
      const out = syntheticFromPayload({ ...(m as Record<string, unknown>), ordinal: idx }, 'network');
      return out;
    })
    .filter((m): m is RawMessage => !!m);
}

function likelyMessagesUrl(url: string): boolean {
  return /message|chat|conversation|inbox/i.test(url);
}

export async function collectMessagesNetworkFirst(page: Page, logger: pino.Logger): Promise<RawMessage[]> {
  const networkMessages: RawMessage[] = [];

  const listener = async (response: Response) => {
    try {
      if (!likelyMessagesUrl(response.url())) return;
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('application/json')) return;
      const json = await response.json();
      const msgs = tryParseMessageList(json);
      if (msgs.length) networkMessages.push(...msgs);
    } catch (error) {
      logger.debug({ err: error }, 'Failed to parse network response as messages');
    }
  };

  page.on('response', listener);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  page.off('response', listener);

  if (networkMessages.length > 0) {
    logger.info({ count: networkMessages.length }, 'Collected messages from network responses');
    return networkMessages;
  }

  logger.info('Network extraction returned no messages; attempting DOM fallback');
  return collectMessagesFromDom(page);
}

export async function collectMessagesFromDom(page: Page): Promise<RawMessage[]> {
  const entries = await page
    .locator('[data-message], .message, [class*="message" i]')
    .evaluateAll((nodes) =>
      nodes.map((n, idx) => ({
        text: (n.textContent ?? '').trim(),
        idx
      }))
    );

  return entries
    .filter((e) => !!e.text)
    .map((e) => ({
      externalChatId: 'dom-chat',
      externalBuyerId: 'dom-buyer',
      itemTitle: null,
      listedPrice: null,
      currency: null,
      messageText: e.text,
      createdAtSource: new Date().toISOString(),
      sourceMessageId: null,
      externalItemKey: null,
      source: 'dom' as const,
      direction: 'inbound' as const,
      ordinalHint: e.idx
    }));
}

export function buildSyntheticMessageId(raw: RawMessage): string {
  if (raw.sourceMessageId) return raw.sourceMessageId;
  const base = [raw.externalChatId, raw.externalBuyerId, raw.direction, raw.createdAtSource ?? '', raw.messageText, raw.ordinalHint ?? '']
    .join('|')
    .toLowerCase();
  return `synmsg_${crypto.createHash('sha256').update(base).digest('hex').slice(0, 24)}`;
}
