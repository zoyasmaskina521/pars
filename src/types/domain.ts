export type CollectorStatus =
  | 'healthy'
  | 'degraded'
  | 'auth_expired'
  | 'challenge_detected'
  | 'site_down'
  | 'retrying'
  | 'recovered';

export interface RawMessage {
  externalChatId: string;
  externalBuyerId: string;
  itemTitle: string | null;
  listedPrice: string | null;
  currency: string | null;
  messageText: string;
  createdAtSource: string | null;
  sourceMessageId: string | null;
  externalItemKey: string | null;
  source: 'network' | 'dom';
  direction: 'inbound' | 'outbound' | 'system';
  ordinalHint?: number;
}

export interface NormalizedEvent {
  external_chat_id: string;
  external_buyer_id: string;
  item_title: string | null;
  listed_price: string | null;
  currency: string;
  message_text: string;
  created_at_source: string;
  source_message_id: string;
  source_event_id: string;
  external_item_key: string | null;
  collector_received_at?: string;
  collector_version?: string;
  source?: string;
}

export interface CollectorConfigRuntime {
  dryRun: boolean;
  smoke: boolean;
}
