import { describe, expect, it } from 'vitest';
import { normalizeRaw } from '../src/normalize/normalizer.js';

describe('normalizer', () => {
  it('builds deterministic ids and defaults', () => {
    const evt = normalizeRaw(
      {
        externalChatId: 'chat-1',
        externalBuyerId: 'buyer-1',
        itemTitle: 'Item',
        listedPrice: '12.00',
        currency: null,
        messageText: 'Hallo',
        createdAtSource: '2026-03-10T10:00:00Z',
        sourceMessageId: null,
        externalItemKey: 'it-1',
        source: 'network',
        direction: 'inbound',
        ordinalHint: 1
      },
      '0.1.0'
    );

    expect(evt.currency).toBe('EUR');
    expect(evt.source_message_id.startsWith('synmsg_')).toBe(true);
    expect(evt.source_event_id.startsWith('ev_')).toBe(true);
  });
});
