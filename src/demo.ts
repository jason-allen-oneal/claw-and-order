import { analyze } from './analyzer.ts';
import { contentFeatures } from './features.ts';
import type { ReviewMessage } from './types.ts';

// Synthetic data only. No token, database, network call, or actual member data.
const guildId = '100000000000000001';
const authorId = '100000000000000002';
const startAt = Date.UTC(2026, 0, 1);
const text = '<tool_call>{"name":"example","arguments":{}}</tool_call> ' + 'Synthetic repeated diagnostic output. '.repeat(4);
const messages: ReviewMessage[] = Array.from({ length: 24 }, (_, i) => ({
  guildId, authorId, messageId: String(100000000000001000n + BigInt(i)),
  channelId: String(100000000000000010n + BigInt(i % 3)),
  createdAt: startAt + i * 120000, replyToId: `synthetic-parent-${i}`,
  replyLatencyMs: 5000 + (i % 2) * 100,
  ...contentFeatures(text, 'synthetic-only-key-not-for-production', guildId, authorId),
}));
console.log(JSON.stringify(analyze({ guildId, authorId, startAt, endAt: startAt + 86400000, messages, truncated: false }), null, 2));
