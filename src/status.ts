import type { Config } from './config.ts';
export function formatMonitoringStatus(config: Config, counters: { writeErrors: number; dropped: number; disconnects: number }): string {
  return [
    'Claw & Order',
    `Activity monitoring: ${config.collectionEnabled ? 'ON - observing new messages in configured channels.' : 'OFF - new messages are NOT being collected.'}`,
    `Content analysis: ${config.contentSignalsEnabled ? 'ON - derived features only; no raw message bodies stored.' : 'OFF - timing/metadata only when monitoring is on.'}`,
    `Configured channels: ${config.observedChannelIds.length}`,
    'History backfill: not implemented. Enabling monitoring does not scan old messages.',
    'Reviews: on demand through /review; no automatic alerts or enforcement.',
    `Retention: ${config.retentionDays} days`,
    `This process: ${JSON.stringify(counters)}`,
    'Probability: unavailable. Coverage is partial; counters reset on restart.',
  ].join('\n');
}
