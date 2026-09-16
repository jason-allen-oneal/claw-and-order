import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.ts';
import { contentFeatures, conversationalText } from '../src/features.ts';
import { loadConfig } from '../src/config.ts';
import { EventQueue } from '../src/queue.ts';
import { reviewInWorker } from '../src/reviewer.ts';
import type { ReviewInput, ReviewMessage } from '../src/types.ts';

const guildId = '100000000000000001';
const authorId = '100000000000000002';
const startAt = 1700000000000;
const key = 'synthetic-test-only-secret-key-12345';
function sample(): ReviewInput {
  const messages: ReviewMessage[] = Array.from({ length: 24 }, (_, i) => ({
    guildId, authorId, messageId: `message-${i}`, channelId: `channel-${i % 3}`,
    createdAt: startAt + i * 120000, replyToId: null, replyLatencyMs: null,
    contentLength: null, fingerprint: null, artifacts: [],
  }));
  return { guildId, authorId, startAt, endAt: startAt + 86400000, messages, truncated: false };
}
function env(): NodeJS.ProcessEnv {
  return { DISCORD_TOKEN: 'synthetic-token', DISCORD_APPLICATION_ID: guildId, DISCORD_GUILD_ID: guildId,
    MODERATOR_CHANNEL_ID: '100000000000000099', DATABASE_URL: 'postgresql://localhost/claw' };
}

test('defaults do not collect content or member activity', () => {
  const config = loadConfig(env());
  assert.equal(config.collectionEnabled, false);
  assert.equal(config.contentSignalsEnabled, false);
  assert.deepEqual(config.observedChannelIds, []);
});
test('string false is not treated as truthy', () => {
  assert.equal(loadConfig({ ...env(), COLLECTION_ENABLED: 'false' }).collectionEnabled, false);
});
test('invalid boolean is rejected', () => {
  assert.throws(() => loadConfig({ ...env(), COLLECTION_ENABLED: 'yes' }), /true or false/);
});
test('live collection requires acknowledgment and explicit channels', () => {
  assert.throws(() => loadConfig({ ...env(), COLLECTION_ENABLED: 'true' }), /ACKNOWLEDGED/);
  assert.throws(() => loadConfig({ ...env(), COLLECTION_ENABLED: 'true', POLICY_REVIEW_ACKNOWLEDGED: 'true' }), /allowlist/);
});
test('wildcard collection and malformed IDs are rejected', () => {
  assert.throws(() => loadConfig({ ...env(), OBSERVED_CHANNEL_IDS: '*' }), /Invalid/);
  assert.throws(() => loadConfig({ ...env(), DISCORD_GUILD_ID: 'oops' }), /Discord ID/);
});
test('review channel cannot be observed', () => {
  assert.throws(() => loadConfig({ ...env(), OBSERVED_CHANNEL_IDS: env().MODERATOR_CHANNEL_ID }), /moderator/);
});
test('content features require an adequate fingerprint key', () => {
  assert.throws(() => loadConfig({ ...env(), COLLECTION_ENABLED: 'true', CONTENT_SIGNALS_ENABLED: 'true',
    POLICY_REVIEW_ACKNOWLEDGED: 'true', OBSERVED_CHANNEL_IDS: '100000000000000010' }), /SECRET/);
  assert.throws(() => contentFeatures('hello', 'short', guildId, authorId), /short/);
});
test('retention and sample limits are bounded', () => {
  assert.throws(() => loadConfig({ ...env(), RETENTION_DAYS: '365' }), /1..30/);
  assert.throws(() => loadConfig({ ...env(), MAX_REVIEW_MESSAGES: '10001' }), /20..10000/);
  assert.throws(() => loadConfig({ ...env(), RETENTION_DAYS: '2.5' }), /integer/);
});
test('quotes and fenced or inline code are excluded', () => {
  assert.equal(conversationalText('Hello\n> tool_use_id\n```json\n{"tool_calls": []}\n```\n`tool_use_id` world'), 'Hello world');
  assert.deepEqual(contentFeatures('```\ntool_use_id\n```', key, guildId, authorId).artifacts, []);
});
test('unclosed fences and multiline quotations do not leak into analysis', () => {
  assert.equal(conversationalText('Hi\n```\ntool_use_id'), 'Hi');
  assert.equal(conversationalText('Hi\n>>> quoted output\ntool_use_id'), 'Hi');
  assert.equal(conversationalText('Hi\n~~~\ntool_use_id\n~~~\nBye'), 'Hi Bye');
});
test('attributed agent logs are not operational artifacts', () => {
  assert.deepEqual(contentFeatures('My agent returned tool_use_id abc123', key, guildId, authorId).artifacts, []);
});
test('feature records never contain raw content', () => {
  const features = contentFeatures('secret user content '.repeat(10), key, guildId, authorId);
  assert.deepEqual(Object.keys(features).sort(), ['artifacts', 'contentLength', 'fingerprint']);
  assert.ok(!JSON.stringify(features).includes('secret user content'));
});
test('fingerprints are scoped to both member and guild', () => {
  const text = 'A human may copy a perfectly ordinary template. '.repeat(4);
  const one = contentFeatures(text, key, guildId, authorId).fingerprint;
  assert.notEqual(one, contentFeatures(text, key, 'another-guild', authorId).fingerprint);
  assert.notEqual(one, contentFeatures(text, key, guildId, 'another-author').fingerprint);
  assert.equal(contentFeatures('hello', key, guildId, authorId).fingerprint, null);
});
test('empty and small samples abstain instead of claiming human', () => {
  assert.equal(analyze({ ...sample(), messages: [] }).priority, 'insufficient-evidence');
  assert.equal(analyze({ ...sample(), messages: sample().messages.slice(0, 10) }).heuristicScore, null);
});
test('baseline data yields no strong indicators, not a human verdict', () => {
  const report = analyze(sample());
  assert.equal(report.priority, 'no-strong-indicators');
  assert.equal(report.automationProbability, null);
  assert.equal(report.heuristicScore, 0);
});
test('replayed message IDs are deduplicated', () => {
  const input = sample();
  assert.equal(analyze({ ...input, messages: [...input.messages, ...input.messages] }).sample.messages, 24);
});
test('other guilds, authors, and out-of-window records are excluded', () => {
  const input = sample();
  input.messages[0]!.guildId = 'other'; input.messages[1]!.authorId = 'other';
  input.messages[2]!.createdAt = input.endAt + 1;
  assert.equal(analyze(input).sample.messages, 21);
});
test('invalid windows and oversized inputs fail', () => {
  assert.throws(() => analyze({ ...sample(), endAt: startAt }), /window/);
  assert.throws(() => analyze({ ...sample(), messages: Array(10001).fill(sample().messages[0]) }), /limit/);
});
test('regular posting intervals are not assumed to be reply latency', () => {
  assert.equal(analyze(sample()).signals.length, 0);
});
test('timing alone cannot escalate a member to review-recommended', () => {
  const input = sample();
  input.messages.forEach((row, i) => { row.replyToId = `parent-${i}`; row.replyLatencyMs = 5000; });
  const report = analyze(input);
  assert.equal(report.priority, 'some-indicators');
  assert.deepEqual(report.signals.map(s => s.family), ['timing']);
});
test('missing and invalid latency values are not interpreted as evidence', () => {
  const input = sample();
  input.messages.forEach((r, i) => { r.replyToId = `parent-${i}`; r.replyLatencyMs = i % 2 ? -1 : Infinity; });
  assert.equal(analyze(input).signals.length, 0);
});
test('repeated substantive text alone has a human-template alternative', () => {
  const input = sample();
  input.messages.forEach(row => { row.fingerprint = 'same-keyed-fingerprint'; row.contentLength = 150; });
  const report = analyze(input);
  assert.equal(report.priority, 'some-indicators');
  assert.match(report.signals[0]!.alternative, /templates/);
});
test('independent features can recommend review but never produce probability', () => {
  const input = sample();
  input.messages.forEach((row, i) => {
    row.fingerprint = 'same-keyed-fingerprint'; row.contentLength = 150;
    row.artifacts = ['tool-envelope']; row.replyToId = `parent-${i}`; row.replyLatencyMs = 5000;
  });
  const report = analyze(input);
  assert.equal(report.priority, 'review-recommended');
  assert.equal(report.automationProbability, null);
  assert.equal(report.signals.length, 3);
  assert.ok(report.heuristicScore! <= 100);
  for (const signal of report.signals) assert.ok(signal.messageIds.every(id => input.messages.some(r => r.messageId === id)));
});
test('truncated samples abstain from aggregate scoring', () => {
  assert.equal(analyze({ ...sample(), truncated: true }).heuristicScore, null);
});
test('bounded queue preserves ordering through failures', async () => {
  const order: number[] = []; let failures = 0;
  const queue = new EventQueue(() => { failures++; });
  queue.enqueue(async () => { order.push(1); });
  queue.enqueue(async () => { throw new Error('synthetic failure'); });
  queue.enqueue(async () => { order.push(2); });
  await queue.drain();
  assert.deepEqual(order, [1, 2]); assert.equal(failures, 1);
});
test('bounded queue rejects excess work', async () => {
  const queue = new EventQueue(() => undefined, 1);
  assert.equal(queue.enqueue(async () => undefined), true);
  assert.equal(queue.enqueue(async () => undefined), false);
  await queue.drain();
  assert.equal(queue.enqueue(async () => undefined), true);
  await queue.drain();
});
test('analysis worker returns the same bounded report', async () => {
  assert.deepEqual(await reviewInWorker(sample()), analyze(sample()));
});
