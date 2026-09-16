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
  const operationalRows = rows.filter(r => r.artifacts.includes('tool-envelope') || r.artifacts.includes('execution-marker'));
  if (operationalRows.length >= 3 && new Set(operationalRows.map(r => r.channelId)).size >= 2) signals.push({
    code: 'operational-markers', family: 'operational-artifact', points: 35,
    description: `${operationalRows.length} messages contain structured tool/execution markers outside excluded text.`,
    messageIds: operationalRows.slice(0, 6).map(r => r.messageId),
    metrics: { messages: operationalRows.length, channels: new Set(operationalRows.map(r => r.channelId)).size,
      markerTypes: new Set(operationalRows.flatMap(r => r.artifacts.filter(a => a === 'tool-envelope' || a === 'execution-marker'))).size },
    alternative: 'Unmarked logs, demonstrations, debugging, and jokes can contain these markers.',
  });
  const stylometryRows = rows.filter(r => r.artifacts.includes('ai-discourse') || r.artifacts.includes('ai-formatting') || r.artifacts.includes('untyped-long-message') || r.artifacts.includes('low-lexical-diversity'));
  const humanRows = rows.filter(r => r.artifacts.includes('human-conversational'));
  const eligibleRows = rows.filter(r => r.contentLength !== null);
  const substantiveRows = rows.filter(r => (r.contentLength ?? 0) >= 60);

  let lengthCV: number | null = null;
  if (substantiveRows.length >= 8) {
    const lengths = substantiveRows.map(r => r.contentLength!);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
    lengthCV = Math.sqrt(variance) / (mean || 1);
  }

  const denominator = eligibleRows.length || rows.length || 1;
  const aiPrevalence = stylometryRows.length / denominator;
  const humanRatio = humanRows.length / (rows.length || 1);
  const isHumanHelperDampened = stylometryRows.length < 5 && (humanRatio >= 0.20 || humanRows.length >= 3) && aiPrevalence < 0.25;

  if (stylometryRows.length >= 2 && !isHumanHelperDampened) {
    const discourseCount = stylometryRows.filter(r => r.artifacts.includes('ai-discourse')).length;
    const formattingCount = stylometryRows.filter(r => r.artifacts.includes('ai-formatting')).length;
    const untypedCount = stylometryRows.filter(r => r.artifacts.includes('untyped-long-message')).length;
    const lexicalCount = stylometryRows.filter(r => r.artifacts.includes('low-lexical-diversity')).length;
    const details: string[] = [];
    if (discourseCount) details.push(`${discourseCount} AI discourse marker${discourseCount > 1 ? 's' : ''}`);
    if (formattingCount) details.push(`${formattingCount} structured list/header pattern${formattingCount > 1 ? 's' : ''}`);
    if (untypedCount) details.push(`${untypedCount} untyped long message${untypedCount > 1 ? 's' : ''}`);
    if (lexicalCount) details.push(`${lexicalCount} low lexical diversity message${lexicalCount > 1 ? 's' : ''}`);
    if (lengthCV !== null && lengthCV < 0.28) details.push(`unnatural length uniformity (CV ${lengthCV.toFixed(2)})`);
    const points = aiPrevalence >= 0.35 || stylometryRows.length >= 5
      ? 35
      : Math.max(15, Math.min(30, Math.round(15 + aiPrevalence * 35)));
    signals.push({
      code: 'ai-stylometry', family: 'stylometry', points,
      description: `${stylometryRows.length} messages exhibit characteristic AI assistant stylometry (${details.join(', ')}). Prevalence: ${Math.round(aiPrevalence * 100)}% of substantive messages.`,
      messageIds: stylometryRows.slice(0, 6).map(r => r.messageId),
      metrics: {
        messages: stylometryRows.length,
        discourseMarkers: discourseCount,
        structuredFormatting: formattingCount,
        untypedMessages: untypedCount,
        lowLexicalDiversityMessages: lexicalCount,
        aiPrevalencePct: Math.round(aiPrevalence * 100),
        humanCounterIndicators: humanRows.length,
        ...(lengthCV !== null ? { lengthCV: Math.round(lengthCV * 100) / 100 } : {}),
      },
      alternative: humanRows.length > 0
        ? `Customer support templates, documentation, or prepared messages can share these markers. Sample also contains ${humanRows.length} message(s) with informal human conversational markers.`
        : 'Polished customer support templates, copy-pasting, or professional writing styles can share these markers.',
    });
  }
  const semanticRows = rows.filter(r => r.semantic && Number.isFinite(r.semantic.score));
  if (semanticRows.length > 0) {
    const average = semanticRows.reduce((sum, row) => sum + row.semantic!.score, 0) / semanticRows.length;
    const high = semanticRows.filter(row => row.semantic!.score >= 60);
    const positive = semanticRows.filter(row => row.semantic!.score > 0);
    const nearestCounts = new Map<string, number>();
    for (const row of semanticRows) {
      const label = row.semantic!.nearestPrototype;
      if (label) nearestCounts.set(label, (nearestCounts.get(label) ?? 0) + 1);
    }
    const nearest = [...nearestCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const margins = semanticRows.map(row => row.semantic!.margin).filter((margin): margin is number => Number.isFinite(margin));
    const averageMargin = margins.length ? margins.reduce((sum, margin) => sum + margin, 0) / margins.length : null;
    const evidenceRows = [...positive].sort((a, b) => b.semantic!.score - a.semantic!.score || a.messageId.localeCompare(b.messageId));
    const nearestText = nearest ? `Nearest prototype most often: ${nearest[0]} (${nearest[1]}/${semanticRows.length} messages).` : 'No nearest prototype was recorded.';
    const marginText = averageMargin === null ? '' : ` Average semantic margin: ${averageMargin.toFixed(3)}.`;
    signals.push({ code: 'semantic-similarity', family: 'semantic', points: Math.min(40, Math.round(average * 0.4)),
      description: `Local semantic prototype classifier scored ${Math.round(average)}/100 across ${semanticRows.length} messages; ${positive.length} had a positive automation-likeness score and ${high.length} scored 60 or higher. ${nearestText}${marginText}`,
      messageIds: evidenceRows.slice(0, 6).map(row => row.messageId),
      metrics: { analyzedMessages: semanticRows.length, averageScore: Math.round(average), positiveScoreMessages: positive.length,
        highScoreMessages: high.length, averageMargin: Math.round((averageMargin ?? 0) * 1000) / 1000 },
      alternative: 'Polished writing, support templates, and a consistent personal style can resemble automated assistant output.',
    });
  }
  // Multiple timing checks are correlated. Count each family ONCE using its strongest
  // contribution; two temporal checks alone must never satisfy the escalation gate.
  const familyScores: Partial<Record<SignalFamily, number>> = {};
  for (const s of signals) if (s.points > 0) familyScores[s.family] = Math.max(familyScores[s.family] ?? 0, s.points);
  const minMessages = input.scoreGate?.minMessages ?? 20;
  const minSpanMs = input.scoreGate?.minSpanMs ?? 30 * 60000;
  const enough = rows.length >= minMessages && spanMs >= minSpanMs && !input.truncated;
  const score = enough ? Math.min(100, Object.values(familyScores).reduce((a, b) => a + b, 0)) : null;
  const priority: Report['priority'] = !enough ? 'insufficient-evidence'
    : Object.keys(familyScores).length >= 2 && score! >= 50 ? 'review-recommended'
    : signals.some(signal => signal.points > 0) ? 'some-indicators' : 'no-strong-indicators';
  return {
    detectorVersion: 'heuristic-v0.3', subject: { guildId: input.guildId, authorId: input.authorId },
    window: { startAt: input.startAt, endAt: input.endAt },
    sample: { messages: rows.length, channels: new Set(rows.map(r => r.channelId)).size, spanMs, truncated: input.truncated },
    priority, heuristicScore: score, familyScores, automationProbability: null, signals,
    limitations: [
      'Experimental, unvalidated heuristics. A score is not a probability or proof of automation.',
      'New-message observations only; no history backfill. Access gaps, disconnections, edits, and deletions reduce coverage.',
      'No finding distinguishes scripted posting from LLM operation. Manually posted AI content is not automated posting.',
      'Language identification, account age, and external server reputation are not scored.',
      'Related checks share a family score cap. Different families are not necessarily statistically independent.',
      'Near-duplicate matching is approximate, candidate-bounded, and limited to the first 1000 tokens of eligible text.',
      ...(rows.length === 0 ? ['No retained messages in the permitted scope/window. Check activity monitoring and channel settings.'] : []),
      ...(rows.some(r => r.contentLength === null) ? ['Content signals are unavailable for some or all messages.'] : []),
      ...(rows.some(r => r.similarity === undefined || r.similarity === null) ? ['Some messages have no similarity sketch (older records, excluded text, or too little eligible content).'] : []),
      ...(input.truncated ? ['Message cap reached. Narrow the window; no aggregate score was assigned.'] : []),
      ...(isHumanHelperDampened ? ['Stylometry escalation withheld: informal human conversational markers predominate over isolated formal messages.'] : []),
      ...(humanRows.length >= 3 && humanRatio >= 0.25 ? [`Observed ${humanRows.length} messages (${Math.round(humanRatio * 100)}%) displaying informal human conversational markers (slang/reactions).`] : []),
      ...(lengthCV !== null && lengthCV >= 0.65 && humanRows.length >= 2 ? ['Natural human message length variability (high burstiness) observed across sample.'] : []),
      ...(!enough && !input.truncated ? [`Aggregate score requires at least ${minMessages} messages spanning ${Math.ceil(minSpanMs / 60000)} minutes.`] : []),
    ],
  };
}
