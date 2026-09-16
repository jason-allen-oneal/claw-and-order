import type { Report, ReviewInput, ReviewMessage, Signal } from './types.ts';

export const MAX_ANALYSIS_MESSAGES = 10000;
export function analyze(input: ReviewInput): Report {
  if (!Number.isFinite(input.startAt) || !Number.isFinite(input.endAt) || input.startAt >= input.endAt) {
    throw new Error('Invalid observation window');
  }
  if (input.messages.length > MAX_ANALYSIS_MESSAGES) throw new Error('Review exceeds analysis limit');
  const unique = new Map<string, ReviewMessage>();
  for (const row of input.messages) {
    if (row.guildId !== input.guildId || row.authorId !== input.authorId || !Number.isFinite(row.createdAt)
      || row.createdAt < input.startAt || row.createdAt > input.endAt) continue;
    if (!unique.has(row.messageId)) unique.set(row.messageId, row);
  }
  const rows = [...unique.values()].sort((a, b) => a.createdAt - b.createdAt);
  const spanMs = rows.length > 1 ? rows[rows.length - 1]!.createdAt - rows[0]!.createdAt : 0;
  const signals: Signal[] = [];

  // Only measured replies count. Missing parents do not become zero-latency replies.
  const replies = rows.filter(r => r.replyToId !== null && r.replyLatencyMs !== null
    && Number.isFinite(r.replyLatencyMs) && r.replyLatencyMs >= 200 && r.replyLatencyMs <= 120000);
  if (replies.length >= 10 && new Set(replies.map(r => r.replyToId)).size >= 10) {
    const times = replies.map(r => r.replyLatencyMs!);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const variance = times.reduce((sum, value) => sum + (value - mean) ** 2, 0) / times.length;
    if (Math.sqrt(variance) / mean <= 0.12) signals.push({
      family: 'timing', points: 30,
      description: `${replies.length} observed replies have low latency variation.`,
      messageIds: replies.slice(0, 5).map(r => r.messageId),
      alternative: 'Active monitoring, scheduled workflows, and measurement artifacts can produce regular timing.',
    });
  }

  const groups = new Map<string, ReviewMessage[]>();
  const eligible = rows.filter(r => r.fingerprint && (r.contentLength ?? 0) >= 80);
  for (const row of eligible) {
    const group = groups.get(row.fingerprint!) ?? [];
    group.push(row); groups.set(row.fingerprint!, group);
  }
  const repeated = [...groups.values()].filter(group => group.length >= 4 && new Set(group.map(r => r.channelId)).size >= 2).flat();
  if (eligible.length >= 10 && repeated.length / eligible.length >= 0.3) signals.push({
    family: 'repetition', points: 30,
    description: `${repeated.length} substantive messages belong to repeated cross-channel text groups.`,
    messageIds: repeated.slice(0, 5).map(r => r.messageId),
    alternative: 'Human support templates, copied answers, and announcements can repeat.',
  });

  const artifacts = rows.filter(r => r.artifacts.length > 0);
  if (artifacts.length >= 3 && new Set(artifacts.map(r => r.channelId)).size >= 2) signals.push({
    family: 'operational-artifact', points: 35,
    description: `${artifacts.length} messages contain candidate tool/execution markers outside excluded text.`,
    messageIds: artifacts.slice(0, 5).map(r => r.messageId),
    alternative: 'Unmarked logs, demonstrations, debugging, and jokes can contain these markers.',
  });

  const enough = rows.length >= 20 && spanMs >= 30 * 60 * 1000 && !input.truncated;
  const score = enough ? Math.min(100, signals.reduce((sum, s) => sum + s.points, 0)) : null;
  const priority: Report['priority'] = !enough ? 'insufficient-evidence'
    : signals.length >= 2 && score! >= 50 ? 'review-recommended'
    : signals.length > 0 ? 'some-indicators' : 'no-strong-indicators';
  return {
    detectorVersion: 'heuristic-v0.1', subject: { guildId: input.guildId, authorId: input.authorId },
    window: { startAt: input.startAt, endAt: input.endAt },
    sample: { messages: rows.length, channels: new Set(rows.map(r => r.channelId)).size, spanMs, truncated: input.truncated },
    priority, heuristicScore: score, automationProbability: null, signals,
    limitations: [
      'Experimental, unvalidated heuristics. A score is not a probability or proof of automation.',
      'Live observations only. Missing access, disconnected periods, edits, and deleted messages reduce coverage.',
      'No finding distinguishes scripted posting from LLM operation. Manually posted AI content is not automated posting.',
      'Punctuation, grammar, language, account age, and nighttime activity are not scored.',
      ...(rows.some(r => r.contentLength === null) ? ['Content signals are unavailable for some or all messages.'] : []),
      ...(input.truncated ? ['Message cap reached. Narrow the window; no aggregate score was assigned.'] : []),
    ],
  };
}
