import { sketchSimilarity, validSketch } from './similarity.ts';
import type { ReviewMessage, Signal } from './types.ts';

export function repetitionSignal(rows: ReviewMessage[]): Signal | null {
  const eligible = rows.filter(r => r.fingerprint && (r.contentLength ?? 0) >= 80);
  const groups: { representative: ReviewMessage; rows: ReviewMessage[]; approximate: boolean }[] = [];
  const exact = new Map<string, number>();
  // Four anchors per group, at most 32 groups per anchor and 64 comparisons per message.
  // No unbounded all-pairs comparison or transitive similarity-chain clustering.
  const anchors = new Map<string, number[]>();
  for (const row of eligible) {
    let index = exact.get(row.fingerprint!);
    const sketch = validSketch(row.similarity) ? row.similarity : null;
    if (index === undefined && sketch) {
      const candidates = new Set<number>();
      for (const hash of sketch.hashes.slice(0, 4)) {
        for (const candidate of anchors.get(hash) ?? []) {
          if (candidates.size < 64) candidates.add(candidate);
        }
      }
      for (const candidate of candidates) {
        const representative = groups[candidate]!.representative.similarity;
        if (representative && sketchSimilarity(sketch, representative) >= 0.78) {
          index = candidate; groups[candidate]!.approximate = true; break;
        }
      }
    }
    if (index === undefined) {
      index = groups.length;
      groups.push({ representative: row, rows: [], approximate: false });
      for (const hash of sketch?.hashes.slice(0, 4) ?? []) {
        const bucket = anchors.get(hash) ?? [];
        if (bucket.length < 32) bucket.push(index);
        anchors.set(hash, bucket);
      }
    }
    exact.set(row.fingerprint!, index);
    groups[index]!.rows.push(row);
  }
  const matches = groups.filter(g => g.rows.length >= 4 && new Set(g.rows.map(r => r.channelId)).size >= 2);
  const repeated = matches.flatMap(g => g.rows);
  if (eligible.length < 10 || repeated.length / eligible.length < 0.3) return null;
  return {
    code: 'repeated-content', family: 'repetition', points: 30,
    description: `${repeated.length}/${eligible.length} substantive messages repeat across channels${matches.some(g => g.approximate) ? ', including near-duplicates' : ''}.`,
    messageIds: repeated.slice(0, 6).map(r => r.messageId),
    metrics: { eligibleMessages: eligible.length, repeatedMessages: repeated.length, groups: matches.length,
      approximateGroups: matches.filter(g => g.approximate).length },
    alternative: 'Human support templates, copied answers, and announcements can repeat. Similar wording does not establish automated posting.',
  };
}
