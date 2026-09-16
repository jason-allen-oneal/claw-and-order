import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { Report, ReviewInput } from './types.ts';
import { reviewStart } from './case-policy.ts';

export interface MonitorHooks {
  cleanSince(): number;
  channels(): Promise<string[]>;
  review(input: ReviewInput): Promise<Report>;
  notify(id: string, retry: boolean): Promise<string>;
  error(kind: 'review' | 'notification'): void;
}
export type MonitorStore = Pick<Store, 'review'> & { cases: Pick<Store['cases'], 'due' | 'latestClosed' | 'postpone' | 'save' | 'pendingNotices' | 'beginNotice' | 'delivered'> };
// Caller owns the process-level review mutex. No overlapping timer callbacks.
export async function monitorTick(store: MonitorStore, config: Config, hooks: MonitorHooks, clock: () => number = Date.now): Promise<void> {
  const jobs = await store.cases.due(config.guildId, clock(), config.autoReviewBatchSize);
  const channels = jobs.length ? await hooks.channels() : [];
  for (const job of jobs) {
    const now = clock();
    try {
      const closedAt = await store.cases.latestClosed(config.guildId, job.authorId);
      if (closedAt !== null && now < closedAt + config.caseCooldownHours * 3600000) {
        await store.cases.postpone(config.guildId, job.authorId, closedAt + config.caseCooldownHours * 3600000); continue;
      }
      const cleanSince = hooks.cleanSince();
      const startAt = reviewStart(now, config.retentionDays, cleanSince, closedAt);
      if (startAt >= now) continue;
      const sample = await store.review(config.guildId, job.authorId, channels, startAt, now, config.maxReviewMessages);
      const report = await hooks.review({ guildId: config.guildId, authorId: job.authorId, startAt, endAt: now, ...sample });
      // A collector fault during analysis invalidates the proposed case.
      if (cleanSince !== hooks.cleanSince()) continue;
      await store.cases.save(config.guildId, job, report, { now, intervalMs: config.autoReviewIntervalSeconds*1000,
        threshold: config.autoCaseThreshold, retentionDays: config.retentionDays });
    } catch {
      hooks.error('review');
      await store.cases.postpone(config.guildId, job.authorId, now + 60000);
    }
  }
  for (const notice of await store.cases.pendingNotices(config.guildId, clock())) {
    if (!await store.cases.beginNotice(config.guildId, notice, clock())) continue;
    try {
      const messageId = await hooks.notify(notice.id, notice.attempts > 0);
      await store.cases.delivered(config.guildId, notice.id, messageId);
    } catch { hooks.error('notification'); }
  }
}
