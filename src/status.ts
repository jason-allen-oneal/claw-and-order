import type { Config } from './config.ts';
export function formatMonitoringStatus(config: Config, counters: { writeErrors: number; dropped: number; disconnects: number }): string {
  return [
    'Claw & Order',
    `Activity monitoring: ${config.collectionEnabled ? 'ON - observing new messages in configured channels.' : 'OFF - new messages are NOT being collected.'}`,
    `Content analysis: ${config.contentSignalsEnabled || config.semanticEnabled ? 'ON - derived features only; no raw message bodies stored.' : 'OFF - timing/metadata only when monitoring is on.'}`,
    `Local semantic classifier: ${config.semanticEnabled ? 'ON - in-process model; no network inference calls.' : 'OFF'}`,
    `Configured channels: ${config.observedChannelIds.length}`,
    'History backfill: available on /review backfill:true; monitoring itself does not scan old messages. Backfill is bounded to configured channels, retention, and the review cap.',
    `Automatic case review: ${config.autoReviewEnabled ? 'ON' : 'OFF'}; on demand /review remains available.`,
    `Automatic review: at most ${config.autoReviewBatchSize} members per ${config.autoReviewTickSeconds}s tick; ${config.autoReviewIntervalSeconds}s per-member interval.`,
    `Case threshold: ${config.autoCaseThreshold}/100 heuristic; resolved-case cooldown: ${config.caseCooldownHours}h.`,
    'Case details: /case show. No automatic enforcement.',
    `Retention: ${config.retentionDays} days`,
    `This process: ${JSON.stringify(counters)}`,
    'Probability: unavailable. Coverage is partial; counters reset on restart.',
  ].join('\n');
}
