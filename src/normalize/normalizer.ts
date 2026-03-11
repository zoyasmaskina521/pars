import crypto from 'node:crypto';
import type { RawMessage, NormalizedEvent } from '../types/domain.js';
import { buildSyntheticMessageId } from '../extractor/extractor.js';

function stableIso(input: string | null): string {
  if (!input) return new Date().toISOString();
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

export function buildSourceEventId(raw: RawMessage, messageId: string): string {
  const primary = [raw.externalChatId, raw.externalBuyerId, messageId, raw.createdAtSource ?? '', raw.direction].join('|');
  return `ev_${crypto.createHash('sha256').update(primary).digest('hex').slice(0, 32)}`;
}

export function normalizeRaw(raw: RawMessage, version: string): NormalizedEvent {
  const sourceMessageId = buildSyntheticMessageId(raw);
  const sourceEventId = buildSourceEventId(raw, sourceMessageId);
  return {
    external_chat_id: raw.externalChatId,
    external_buyer_id: raw.externalBuyerId,
    item_title: raw.itemTitle,
    listed_price: raw.listedPrice,
    currency: raw.currency ?? 'EUR',
    message_text: raw.messageText,
    created_at_source: stableIso(raw.createdAtSource),
    source_message_id: sourceMessageId,
    source_event_id: sourceEventId,
    external_item_key: raw.externalItemKey,
    collector_received_at: new Date().toISOString(),
    collector_version: version,
    source: raw.source
  };
}
