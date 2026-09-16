import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.ts';
import { contentFeatures } from '../src/features.ts';
import { makeSketch, sketchSimilarity, validSketch } from '../src/similarity.ts';
import { formatMonitoringStatus } from '../src/status.ts';
import { loadConfig } from '../src/config.ts';
import { reviewInWorker } from '../src/reviewer.ts';
import type { ReviewInput, ReviewMessage } from '../src/types.ts';
const guildId = '100000000000000001'; const authorId = '100000000000000002';
const startAt = Date.UTC(2026, 0, 1); const key = 'synthetic-test-only-secret-key-12345';
const text = 'Inspect the configuration carefully before changing any options. Record the previous values so the operation can be reversed. Compare the observed output with the documented behavior and keep a copy of the diagnostic information. The relevant setting should be checked in every affected environment. After making a controlled change, repeat the original test and verify that the expected behavior has returned. Document any remaining differences for the next review. Do not assume that a successful restart means the underlying problem has been resolved.';
function sample(count = 24): ReviewInput {
  const messages: ReviewMessage[] = Array.from({ length: count }, (_, i) => ({
    guildId, authorId, messageId: `message-${i}`, channelId: `channel-${i % 3}`,
    createdAt: startAt + i * 120000, replyToId: null, replyLatencyMs: null,
    contentLength: null, fingerprint: null, artifacts: [],
  }));
  return { guildId, authorId, startAt, endAt: startAt + 86400000, messages, truncated: false };
}
test('near-duplicate content survives a changing suffix without storing text', () => {
  const a = contentFeatures(text + ' Case number alpha.', key, guildId, authorId);
  const b = contentFeatures(text + ' Case number beta.', key, guildId, authorId);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.ok(a.similarity && b.similarity);
  assert.ok(sketchSimilarity(a.similarity, b.similarity) >= 0.78);
  assert.ok(!JSON.stringify(a).includes('Inspect'));
});
test('similarity is symmetric, identical sketches score one, unrelated ones do not match', () => {
  const a = makeSketch(text, key, guildId, authorId)!;
  const b = makeSketch(Array.from({ length: 80 }, (_, i) => `unrelatedword${i}`).join(' '), key, guildId, authorId)!;
  assert.equal(sketchSimilarity(a, a), 1);
  assert.equal(sketchSimilarity(a, b), sketchSimilarity(b, a));
  assert.ok(sketchSimilarity(a, b) < 0.1);
});
test('short/filler text has no sketch; malformed stored sketches fail closed', () => {
  assert.equal(makeSketch('hello world', key, guildId, authorId), null);
  assert.equal(makeSketch('hello '.repeat(80), key, guildId, authorId), null);
  const s = makeSketch(text, key, guildId, authorId)!;
  assert.equal(validSketch(s), true);
  assert.equal(validSketch({ ...s, hashes: ['not-a-hash'] }), false);
  assert.equal(validSketch({ ...s, hashes: [...s.hashes].reverse() }), false);
  assert.equal(validSketch({ ...s, hashes: Array(100).fill(s.hashes[0]) }), false);
  assert.equal(validSketch({ ...s, tokenCount: Infinity }), false);
});
test('sketches are scoped by guild, member, and secret', () => {
  const a = makeSketch(text, key, guildId, authorId)!;
  for (const b of [makeSketch(text, key, 'other-guild', authorId), makeSketch(text, key, guildId, 'other-member'),
    makeSketch(text, key + 'different', guildId, authorId)]) {
    assert.equal(sketchSimilarity(a, b!), 0);
  }
});
test('near-duplicates form one repetition signal, not one signal per matched pair', () => {
  const input = sample();
  input.messages.forEach((row, i) => Object.assign(row, contentFeatures(text + ` Case number case${i}.`, key, guildId, authorId)));
  const report = analyze(input);
  assert.equal(report.priority, 'some-indicators');
  assert.equal(report.signals.length, 1);
  assert.equal(report.signals[0]!.code, 'repeated-content');
  assert.ok(report.signals[0]!.metrics.approximateGroups! > 0);
  assert.equal(report.heuristicScore, 30);
});
test('single-channel near-duplicates are not cross-channel repetition', () => {
  const input = sample();
  input.messages.forEach((row, i) => {
    row.channelId = 'one-channel'; Object.assign(row, contentFeatures(text + ` Case case${i}.`, key, guildId, authorId));
  });
  assert.equal(analyze(input).signals.length, 0);
});
test('attributed support logs contribute no repetition, burst, or artifact content features', () => {
  const features = contentFeatures('My agent returned ' + text + ' tool_use_id=abc123', key, guildId, authorId);
  assert.equal(features.fingerprint, null); assert.equal(features.similarity, null);
  assert.equal(features.contentLength, 0); assert.deepEqual(features.artifacts, []);
});
test('discussing tool vocabulary, pending, and polished writing is not an operational marker', () => {
  for (const value of ['What is tool_use_id in the documentation?', 'Why does tool_calls exist?', 'pending', text]) {
    assert.deepEqual(contentFeatures(value, key, guildId, authorId).artifacts, []);
  }
});
test('structured execution envelopes are recognized outside quotes and code', () => {
  assert.deepEqual(contentFeatures('assistant to=tools.lookup', key, guildId, authorId).artifacts, ['execution-marker']);
  assert.deepEqual(contentFeatures('tool_use_id="abc123"', key, guildId, authorId).artifacts, ['execution-marker']);
  assert.deepEqual(contentFeatures('<function_calls>{"name":"example"}</function_calls>', key, guildId, authorId).artifacts, ['tool-envelope']);
  assert.deepEqual(contentFeatures('> assistant to=tools.lookup', key, guildId, authorId).artifacts, []);
});
test('a few delayed replies no longer erase an otherwise persistent cadence', () => {
  const input = sample();
  input.messages.forEach((r, i) => { r.replyToId = `parent-${i}`; r.replyLatencyMs = i < 20 ? 5000 : 80000; });
  const report = analyze(input);
  assert.equal(report.signals[0]!.code, 'reply-cadence');
  assert.equal(report.signals[0]!.metrics.regularReplies, 20);
  assert.equal(report.priority, 'some-indicators');
});
test('multiple chunks replying to the same parent do not inflate distinct responses', () => {
  const input = sample();
  input.messages.forEach((r, i) => { r.replyToId = `parent-${i % 3}`; r.replyLatencyMs = 5000; });
  assert.equal(analyze(input).signals.length, 0);
});
function burstSample(): ReviewInput {
  const input = sample();
  input.messages.forEach((r, i) => {
    r.createdAt = startAt + Math.floor(i / 3) * 10 * 60000 + (i % 3) * 4000;
    r.contentLength = 400; r.fingerprint = `distinct-${i}`;
    r.replyToId = `parent-${i}`; r.replyLatencyMs = 5000;
  });
  return input;
}
test('repeated cross-channel reply bursts are detected without doubling temporal scores', () => {
  const report = analyze(burstSample());
  assert.ok(report.signals.some(s => s.code === 'cross-channel-bursts'));
  assert.ok(report.signals.some(s => s.code === 'reply-cadence'));
  assert.equal(report.heuristicScore, 35);
  assert.equal(report.familyScores.timing, 35);
  assert.equal(report.priority, 'some-indicators');
  assert.equal(report.automationProbability, null);
});
test('rapid copies of one announcement do not qualify as different reply bursts', () => {
  const input = burstSample(); input.messages.forEach(r => { r.fingerprint = 'one-announcement'; });
  assert.ok(!analyze(input).signals.some(s => s.code === 'cross-channel-bursts'));
});
test('short messages, absent reply parents, and one channel do not qualify as parallel replies', () => {
  for (const change of [
    (r: ReviewMessage) => { r.contentLength = 12; },
    (r: ReviewMessage) => { r.replyToId = null; r.replyLatencyMs = null; },
    (r: ReviewMessage) => { r.channelId = 'one-channel'; },
  ]) {
    const input = burstSample(); input.messages.forEach(change);
    assert.ok(!analyze(input).signals.some(s => s.code === 'cross-channel-bursts'));
  }
});
test('one dense burst is not counted as multiple recurring episodes', () => {
  const input = burstSample(); input.messages.forEach((r, i) => { r.createdAt = startAt + i * 100; });
  assert.ok(!analyze(input).signals.some(s => s.code === 'cross-channel-bursts'));
});
test('input ordering does not change evidence and every cited ID belongs to the sample', () => {
  const input = burstSample(); const report = analyze(input);
  assert.deepEqual(analyze({ ...input, messages: [...input.messages].reverse() }), report);
  for (const signal of report.signals) assert.ok(signal.messageIds.every(id => input.messages.some(r => r.messageId === id)));
});
test('monitoring status explains OFF, no backfill, and on-demand reviews', () => {
  const config = loadConfig({ DISCORD_TOKEN: 'synthetic', DISCORD_APPLICATION_ID: guildId, DISCORD_GUILD_ID: guildId,
    MODERATOR_CHANNEL_ID: '100000000000000099', DATABASE_URL: 'postgresql://localhost/claw' });
  const status = formatMonitoringStatus(config, { writeErrors: 0, dropped: 0, disconnects: 0 });
  assert.match(status, /OFF - new messages are NOT being collected/);
  assert.match(status, /does not scan old messages/);
  assert.match(status, /on demand/);
});
test('empty samples explain missing observations instead of silently implying a human', () => {
  const report = analyze(sample(0));
  assert.equal(report.priority, 'insufficient-evidence');
  assert.ok(report.limitations.some(l => l.includes('No retained messages')));
});
test('bounded worker handles the maximum sample with keyed sketches', async () => {
  const input = sample(10000);
  input.endAt = startAt + 10000 * 120000;
  const features = contentFeatures(text, key, guildId, authorId);
  input.messages.forEach(r => Object.assign(r, features));
  const report = await reviewInWorker(input);
  assert.equal(report.sample.messages, 10000);
  assert.equal(report.priority, 'some-indicators');
});
