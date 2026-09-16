import type { Report, ReviewInput, ReviewMessage, Signal, SignalFamily } from './types.ts';
import { repetitionSignal } from './repetition.ts';
import { timingSignals } from './timing.ts';

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
  const rows = [...unique.values()].sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
  const spanMs = rows.length > 1 ? rows[rows.length - 1]!.createdAt - rows[0]!.createdAt : 0;
  const signals: Signal[] = timingSignals(rows);
  const repetition = repetitionSignal(rows);
  if (repetition) signals.push(repetition);
  const artifacts = rows.filter(r => r.artifacts.length > 0);
  if (artifacts.length >= 3 && new Set(artifacts.map(r => r.channelId)).size >= 2) signals.push({
    code: 'operational-markers', family: 'operational-artifact', points: 35,
    description: `${artifacts.length} messages contain structured tool/execution markers outside excluded text.`,
    messageIds: artifacts.slice(0, 6).map(r => r.messageId),
    metrics: { messages: artifacts.length, channels: new Set(artifacts.map(r => r.channelId)).size,
      markerTypes: new Set(artifacts.flatMap(r => r.artifacts)).size },
    alternative: 'Unmarked logs, demonstrations, debugging, and jokes can contain these markers.',
  });
  // Multiple timing checks are correlated. Count each family ONCE using its strongest
  // contribution; two temporal checks alone must never satisfy the escalation gate.
  const familyScores: Partial<Record<SignalFamily, number>> = {};
  for (const s of signals) familyScores[s.family] = Math.max(familyScores[s.family] ?? 0, s.points);
  const enough = rows.length >= 20 && spanMs >= 30 * 60000 && !input.truncated;
  const score = enough ? Math.min(100, Object.values(familyScores).reduce((a, b) => a + b, 0)) : null;
  const priority: Report['priority'] = !enough ? 'insufficient-evidence'
    : Object.keys(familyScores).length >= 2 && score! >= 50 ? 'review-recommended'
    : signals.length > 0 ? 'some-indicators' : 'no-strong-indicators';
  return {
    detectorVersion: 'heuristic-v0.2', subject: { guildId: input.guildId, authorId: input.authorId },
    window: { startAt: input.startAt, endAt: input.endAt },
    sample: { messages: rows.length, channels: new Set(rows.map(r => r.channelId)).size, spanMs, truncated: input.truncated },
    priority, heuristicScore: score, familyScores, automationProbability: null, signals,
    limitations: [
      'Experimental, unvalidated heuristics. A score is not a probability or proof of automation.',
      'New-message observations only; no history backfill. Access gaps, disconnections, edits, and deletions reduce coverage.',
      'No finding distinguishes scripted posting from LLM operation. Manually posted AI content is not automated posting.',
      'Punctuation, grammar, language, account age, and nighttime activity are not scored.',
      'Related checks share a family score cap. Different families are not necessarily statistically independent.',
      'Near-duplicate matching is approximate, candidate-bounded, and limited to the first 1000 tokens of eligible text.',
      ...(rows.length === 0 ? ['No retained messages in the permitted scope/window. Check activity monitoring and channel settings.'] : []),
      ...(rows.some(r => r.contentLength === null) ? ['Content signals are unavailable for some or all messages.'] : []),
      ...(rows.some(r => r.similarity === undefined || r.similarity === null) ? ['Some messages have no similarity sketch (older records, excluded text, or too little eligible content).'] : []),
      ...(input.truncated ? ['Message cap reached. Narrow the window; no aggregate score was assigned.'] : []),
    ],
  };
}
