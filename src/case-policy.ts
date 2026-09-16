import type { Report } from './types.ts';

export type CaseStatus = 'open' | 'dismissed' | 'inconclusive' | 'confirmed-automation';
export type Resolution = Exclude<CaseStatus, 'open'>;
export const resolutions: readonly Resolution[] = ['dismissed', 'inconclusive', 'confirmed-automation'];
export function isCaseId(value: string): boolean { return /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n; }
export function shouldOpenCase(report: Report, threshold: number): boolean {
  return report.priority === 'review-recommended' && !report.sample.truncated
    && report.heuristicScore !== null && Number.isFinite(report.heuristicScore)
    && report.heuristicScore >= threshold && Object.keys(report.familyScores).length >= 2;
}
export function reviewStart(now: number, windowDays: number, cleanSince: number, closedAt: number | null): number {
  return Math.max(now - windowDays * 86400000, cleanSince, closedAt === null ? 0 : closedAt + 1);
}
export function notificationText(id: string): string {
  if (!isCaseId(id)) throw new Error('Invalid case ID');
  // No subject, score, source channel, message excerpt, or evidence link is posted publicly.
  return `Claw & Order | case:${id}\nActivity review requested. Use /case show id:${id} in this moderator channel.\nThis is a review request, not an automation verdict. No enforcement was taken.`;
}
export function retryDelay(attempts: number): number { return Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7)); }
