import type { ReviewMessage, Signal } from './types.ts';
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
export function timingSignals(rows: ReviewMessage[]): Signal[] {
  // One response per observed parent. Chunking an answer is not multiple reactions.
  const seen = new Set<string>();
  const replies = rows.filter(r => {
    if (!r.replyToId || r.replyLatencyMs === null || !Number.isFinite(r.replyLatencyMs)
      || r.replyLatencyMs < 200 || r.replyLatencyMs > 120000 || seen.has(r.replyToId)) return false;
    seen.add(r.replyToId); return true;
  });
  const signals: Signal[] = [];
  if (replies.length >= 10) {
    const middle = median(replies.map(r => r.replyLatencyMs!));
    const regular = replies.filter(r => Math.abs(r.replyLatencyMs! - middle) <= Math.max(200, middle * 0.15));
    const span = regular.length ? regular[regular.length - 1]!.createdAt - regular[0]!.createdAt : 0;
    if (regular.length >= 10 && regular.length / replies.length >= 0.8 && span >= 20 * 60000) {
      signals.push({ code: 'reply-cadence', family: 'timing', points: 30,
        description: `${regular.length}/${replies.length} distinct observed replies cluster around ${(middle / 1000).toFixed(1)} seconds.`,
        messageIds: regular.slice(0, 6).map(r => r.messageId),
        metrics: { distinctReplies: replies.length, regularReplies: regular.length, medianLatencyMs: middle,
          medianAbsoluteDeviationMs: median(replies.map(r => Math.abs(r.replyLatencyMs! - middle))) },
        alternative: 'Active monitoring, human routines, and measurement artifacts can produce consistent response timing.',
      });
    }
  }
  // Repeated, separate bursts of DIFFERENT substantial replies across three channels.
  // Source creation timestamps are used, never Gateway arrival/reconnect timing.
  const substantial = replies.filter(r => (r.contentLength ?? 0) >= 240 && r.fingerprint);
  const episodes: ReviewMessage[][] = [];
  let lastEpisode = -Infinity;
  for (let i = 0; i < substantial.length; i++) {
    const first = substantial[i]!;
    if (first.createdAt - lastEpisode < 5 * 60000) continue;
    const chosen: ReviewMessage[] = [];
    const channels = new Set<string>(); const texts = new Set<string>();
    for (let j = i; j < Math.min(substantial.length, i + 64) && substantial[j]!.createdAt - first.createdAt <= 15000; j++) {
      const row = substantial[j]!;
      if (!channels.has(row.channelId) && !texts.has(row.fingerprint!)) {
        channels.add(row.channelId); texts.add(row.fingerprint!); chosen.push(row);
      }
      if (chosen.length === 3) break;
    }
    if (chosen.length === 3) { episodes.push(chosen); lastEpisode = first.createdAt; }
  }
  if (episodes.length >= 3) {
    signals.push({ code: 'cross-channel-bursts', family: 'timing', points: 35,
      description: `${episodes.length} separate bursts contain three different substantial replies across three channels within 15 seconds.`,
      messageIds: episodes.slice(0, 3).flatMap(e => e.map(r => r.messageId)),
      metrics: { episodes: episodes.length, minimumChannels: 3, maximumBurstMs: 15000, minimumSeparationMs: 300000 },
      alternative: 'A person can prepare, paste, or dispatch several answers. This measures posting patterns, not how long composition took.',
    });
  }
  return signals;
}
