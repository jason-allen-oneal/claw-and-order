import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer.ts';
import { contentFeatures } from '../src/features.ts';
import { shouldOpenCase } from '../src/case-policy.ts';
import type { ReviewInput, ReviewMessage } from '../src/types.ts';

const guildId = '100000000000000001';
const authorId = '100000000000000002';
const startAt = 1700000000000;
const key = 'synthetic-test-only-secret-key-12345';

function baseSample(count = 24): ReviewInput {
  const messages: ReviewMessage[] = Array.from({ length: count }, (_, i) => ({
    guildId, authorId, messageId: `message-${i}`, channelId: `channel-${i % 3}`,
    createdAt: startAt + i * 120000, replyToId: null, replyLatencyMs: null,
    contentLength: null, fingerprint: null, artifacts: [],
  }));
  return { guildId, authorId, startAt, endAt: startAt + 86400000, messages, truncated: false };
}

test('AI discourse markers and formatting are recognized', () => {
  const aiText = 'Certainly! Here is a breakdown of the solution:\n1. **Step One:** Install the required package.\n2. **Step Two:** Start the service.\nI hope this helps! Feel free to ask if you have any further questions.';
  const features = contentFeatures(aiText, key, guildId, authorId);
  assert.ok(features.artifacts.includes('ai-discourse'));
  assert.ok(features.artifacts.includes('ai-formatting'));

  const naturalText = 'yeah I think we can check the logs later tonight, heading out for lunch now.';
  const naturalFeatures = contentFeatures(naturalText, key, guildId, authorId);
  assert.deepEqual(naturalFeatures.artifacts, ['human-conversational']);

  const neutralText = 'The quick brown fox jumps over the lazy dog.';
  const neutralFeatures = contentFeatures(neutralText, key, guildId, authorId);
  assert.deepEqual(neutralFeatures.artifacts, []);
});

test('untyped long messages flag an artifact when untyped option is passed', () => {
  const longText = 'This is a long message that contains detailed instructions and explanation. '.repeat(4);
  const untypedFeatures = contentFeatures(longText, key, guildId, authorId, { untyped: true });
  assert.ok(untypedFeatures.artifacts.includes('untyped-long-message'));

  const typedFeatures = contentFeatures(longText, key, guildId, authorId, { untyped: false });
  assert.ok(!typedFeatures.artifacts.includes('untyped-long-message'));
});

test('ai-stylometry signal is reported and contributes to the stylometry family', () => {
  const input = baseSample();
  const aiText = 'Certainly! Here is a breakdown:\n1. **Config:** Set options.\n2. **Run:** Execute task.\nHope this helps!';
  for (let i = 0; i < 6; i++) {
    Object.assign(input.messages[i]!, contentFeatures(aiText, key, guildId, authorId));
  }
  const report = analyze(input);
  const signal = report.signals.find(s => s.code === 'ai-stylometry');
  assert.ok(signal);
  assert.equal(signal.family, 'stylometry');
  assert.ok(signal.points > 0);
  assert.equal(report.familyScores.stylometry, signal.points);
  assert.ok(signal.messageIds.length > 0);
});

test('rapid response speed signal detects superhuman composition speed', () => {
  const input = baseSample();
  for (let i = 0; i < 6; i++) {
    input.messages[i]!.replyToId = `parent-${i}`;
    input.messages[i]!.contentLength = 300;
    input.messages[i]!.replyLatencyMs = 1500; // 300 chars in 1.5s = 200 chars/sec
  }
  const report = analyze(input);
  const signal = report.signals.find(s => s.code === 'rapid-response-speed');
  assert.ok(signal);
  assert.equal(signal.family, 'timing');
  assert.equal(signal.points, 30);
  assert.equal(report.familyScores.timing, 30);
});

test('AI user accounts with stylometry and semantic similarity satisfy automatic case escalation', () => {
  const input = baseSample();
  const aiText = 'Certainly! Here is a breakdown:\n1. **Config:** Set options.\n2. **Run:** Execute task.\nHope this helps!';
  input.messages.forEach((m) => {
    Object.assign(m, contentFeatures(aiText, key, guildId, authorId));
    m.semantic = {
      score: 85,
      reasons: ['Strong match to conversational assistant'],
      nearestPrototype: 'conversational ai assistant',
      similarity: 0.85,
      margin: 0.45,
    };
  });
  const report = analyze(input);
  assert.equal(report.priority, 'review-recommended');
  assert.ok(report.heuristicScore! >= 60);
  assert.ok(Object.keys(report.familyScores).length >= 2);
  assert.ok(report.familyScores.stylometry! > 0);
  assert.ok(report.familyScores.semantic! > 0);
  assert.equal(shouldOpenCase(report, 60), true);
});

test('human conversational counter-evidence dampens isolated stylometry false positives', () => {
  const input = baseSample(24);
  const structuredText = '1. **Rule One:** Be respectful.\n2. **Rule Two:** No spam.\nImportant to keep in mind.';
  // 2 formal messages
  Object.assign(input.messages[0]!, contentFeatures(structuredText, key, guildId, authorId));
  Object.assign(input.messages[1]!, contentFeatures(structuredText, key, guildId, authorId));
  // 12 casual human messages with slang and informal chatter
  for (let i = 2; i < 14; i++) {
    Object.assign(input.messages[i]!, contentFeatures('tbh idk if that works haha lmao', key, guildId, authorId));
  }
  // 10 ordinary chat messages
  for (let i = 14; i < 24; i++) {
    Object.assign(input.messages[i]!, contentFeatures('heading out for lunch now', key, guildId, authorId));
  }
  const report = analyze(input);
  // Stylometry should be dampened due to low prevalence (<20%) and high human markers (>30%)
  assert.equal(report.signals.some(s => s.code === 'ai-stylometry'), false);
  assert.notEqual(report.priority, 'review-recommended');
  assert.ok(report.limitations.some(l => l.includes('withheld')));
});

test('stealth AI accounts with uniform length distribution report CV uniformity metrics', () => {
  const input = baseSample(12);
  const aiTexts = [
    'Regarding your question about deployment, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about monitoring, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about automation, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about databases, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about channels, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about permissions, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about networking, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about firewalls, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about logging, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about backups, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about recovery, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
    'Regarding your question about security, here are the instructions for configuring the system properly: 1. **Step:** Config. 2. **Step:** Run. Hope this helps!',
  ];
  input.messages.forEach((m, idx) => {
    Object.assign(m, contentFeatures(aiTexts[idx]!, key, guildId, authorId));
  });
  const report = analyze(input);
  const signal = report.signals.find(s => s.code === 'ai-stylometry');
  assert.ok(signal);
  assert.ok(signal.description.includes('uniformity'));
  assert.ok(typeof signal.metrics.lengthCV === 'number');
  assert.ok(signal.metrics.lengthCV! < 0.28);
});

test('Discord-native emotes, mentions, emojis, and casual lowercase start are recognized as human counter-indicators', () => {
  const customEmote = contentFeatures('great job <:pepe_clap:100000000000000001>', key, guildId, authorId);
  assert.ok(customEmote.artifacts.includes('human-conversational'));

  const unicodeEmoji = contentFeatures('not sure about that 💀😭', key, guildId, authorId);
  assert.ok(unicodeEmoji.artifacts.includes('human-conversational'));

  const mention = contentFeatures('check with <@100000000000000099> first', key, guildId, authorId);
  assert.ok(mention.artifacts.includes('human-conversational'));

  const casualLower = contentFeatures('hey did you catch that stream earlier', key, guildId, authorId);
  assert.ok(casualLower.artifacts.includes('human-conversational'));

  const casualSlang = contentFeatures('bruh that is kinda sus no cap', key, guildId, authorId);
  assert.ok(casualSlang.artifacts.includes('human-conversational'));
});

test('unbroken circadian response cadence detects accounts replying 24/7 without a sleep window', () => {
  const input = baseSample(40);
  input.endAt = startAt + 40 * 3600000;
  for (let i = 0; i < 40; i++) {
    input.messages[i]!.createdAt = startAt + i * 3600000; // 1 reply per hour for 40 hours
    input.messages[i]!.replyToId = `parent-${i}`;
    input.messages[i]!.replyLatencyMs = 12000;
  }
  const report = analyze(input);
  const signal = report.signals.find(s => s.code === 'unbroken-circadian');
  assert.ok(signal);
  assert.equal(signal.family, 'timing');
  assert.equal(signal.points, 30);
  assert.ok(signal.metrics.activeHours! >= 20);
  assert.ok(signal.metrics.maxGapHours! <= 2);
  assert.ok(signal.description.includes('without a human sleep interval'));
});

test('modern LLM discourse transitions and markdown headings are recognized', () => {
  const text = 'Here is what you need to know:\n### Overview\nKeep in mind that this is experimental. Don\'t hesitate to reach out if you need assistance!';
  const features = contentFeatures(text, key, guildId, authorId);
  assert.ok(features.artifacts.includes('ai-discourse'));
  assert.ok(features.artifacts.includes('ai-formatting'));
});

test('bot command invocations are excluded from content signals', () => {
  for (const cmd of ['!play music track', '!rank', '?help user', '$price btc', '-skip', '%stats']) {
    const res = contentFeatures(cmd, key, guildId, authorId);
    assert.equal(res.contentLength, 0);
    assert.equal(res.fingerprint, null);
    assert.deepEqual(res.artifacts, []);
  }
});

test('attachment and media telemetry marks human-conversational artifact', () => {
  const withMedia = contentFeatures('here is the error screenshot', key, guildId, authorId, { hasMedia: true });
  assert.ok(withMedia.artifacts.includes('human-conversational'));

  const stickerOnly = contentFeatures('', key, guildId, authorId, { hasMedia: true });
  assert.ok(stickerOnly.artifacts.includes('human-conversational'));
});

test('repetitive vocabulary with low lexical diversity triggers artifact', () => {
  const repetitiveText = 'buy crypto coin moon buy crypto coin moon buy crypto coin moon buy crypto coin moon buy crypto coin moon';
  const features = contentFeatures(repetitiveText, key, guildId, authorId);
  assert.ok(features.artifacts.includes('low-lexical-diversity'));
});

test('healthcheck HTTP server serves /healthz status', async () => {
  const { startHealthServer } = await import('../src/health.ts');
  const server = startHealthServer(0, async () => ({
    status: 'ok',
    uptimeSeconds: 42,
    database: 'connected',
    discord: { ready: true, pingMs: 15 },
    counters: { disconnects: 0 },
  }));

  try {
    await new Promise(r => setTimeout(r, 50));
    const port = server.port();
    assert.ok(port > 0);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const data = await res.json() as { status: string; database: string; uptimeSeconds: number };
    assert.equal(data.status, 'ok');
    assert.equal(data.database, 'connected');
    assert.equal(data.uptimeSeconds, 42);
  } finally {
    await server.close();
  }
});

