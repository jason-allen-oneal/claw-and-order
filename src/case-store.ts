import type pg from 'pg';
import type { Report } from './types.ts';
import { resolutions, retryDelay, shouldOpenCase } from './case-policy.ts';
import type { CaseStatus, Resolution } from './case-policy.ts';

export interface ReviewJob { authorId: string; revision: string }
export interface CaseRecord {
  id: string; authorId: string; status: CaseStatus; createdAt: number; closedAt: number | null;
  priority: string; score: number | null;
}
export interface Notice { id: string; attempts: number }
export class CaseStore {
  private pool: pg.Pool;
  constructor(pool: pg.Pool) { this.pool = pool; }
  async seed(guildId: string, cutoff: number): Promise<void> {
    await this.pool.query(`INSERT INTO review_jobs(guild_id,author_id)
      SELECT DISTINCT guild_id,author_id FROM observations WHERE guild_id=$1 AND created_at >= $2
      ON CONFLICT DO NOTHING`, [guildId, new Date(cutoff)]);
  }
  async due(guildId: string, now: number, limit: number): Promise<ReviewJob[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Invalid batch limit');
    const { rows } = await this.pool.query(`SELECT author_id,revision FROM review_jobs
      WHERE guild_id=$1 AND dirty AND due_at <= $2 ORDER BY due_at,author_id LIMIT $3`, [guildId,new Date(now),limit]);
    return rows.map(r => ({ authorId: String(r.author_id), revision: String(r.revision) }));
  }
  async latestClosed(guildId: string, authorId: string): Promise<number | null> {
    const { rows } = await this.pool.query(`SELECT max(closed_at) AS closed FROM moderation_cases
      WHERE guild_id=$1 AND author_id=$2`, [guildId,authorId]);
    return rows[0]?.closed ? new Date(rows[0].closed as string).getTime() : null;
  }
  async postpone(guildId: string, authorId: string, until: number): Promise<void> {
    await this.pool.query('UPDATE review_jobs SET due_at=$3 WHERE guild_id=$1 AND author_id=$2', [guildId,authorId,new Date(until)]);
  }
  async save(guildId: string, job: ReviewJob, report: Report, options: {
    now: number; intervalMs: number; threshold: number; retentionDays: number;
  }): Promise<'stale' | 'created' | 'updated' | 'none'> {
    if (report.subject.guildId !== guildId || report.subject.authorId !== job.authorId) throw new Error('Review subject mismatch');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const current = await db.query('SELECT revision FROM review_jobs WHERE guild_id=$1 AND author_id=$2 FOR UPDATE', [guildId,job.authorId]);
      if (String(current.rows[0]?.revision) !== job.revision) { await db.query('ROLLBACK'); return 'stale'; }
      const now = new Date(options.now);
      const expires = new Date(options.now + options.retentionDays * 86400000);
      const existing = await db.query(`UPDATE moderation_cases SET priority=$3,score=$4,detector_version=$5,updated_at=$6
        WHERE guild_id=$1 AND author_id=$2 AND status='open' RETURNING id`,
      [guildId,job.authorId,report.priority,report.heuristicScore,report.detectorVersion,now]);
      let outcome: 'created' | 'updated' | 'none' = existing.rowCount ? 'updated' : 'none';
      if (!existing.rowCount && shouldOpenCase(report, options.threshold)) {
        const created = await db.query(`INSERT INTO moderation_cases
          (guild_id,author_id,expires_at,priority,score,detector_version,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING RETURNING id`,
        [guildId,job.authorId,expires,report.priority,report.heuristicScore,report.detectorVersion,now]);
        if (created.rows[0]) {
          await db.query('INSERT INTO case_outbox(case_id) VALUES($1)', [created.rows[0].id]);
          outcome = 'created';
        }
      }
      await db.query(`UPDATE review_jobs SET dirty=false,due_at=$3 WHERE guild_id=$1 AND author_id=$2`,
        [guildId,job.authorId,new Date(options.now + options.intervalMs)]);
      await db.query('COMMIT'); return outcome;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async get(guildId: string, id: string): Promise<CaseRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM moderation_cases WHERE guild_id=$1 AND id=$2', [guildId,id]);
    const r = rows[0];
    return r ? { id: String(r.id), authorId: String(r.author_id), status: r.status as CaseStatus,
      createdAt: new Date(r.created_at as string).getTime(), closedAt: r.closed_at ? new Date(r.closed_at as string).getTime() : null,
      priority: String(r.priority), score: r.score as number | null } : null;
  }
  async list(guildId: string, beforeId: string | null): Promise<{ id: string; status: string }[]> {
    const { rows } = await this.pool.query(`SELECT id,status FROM moderation_cases WHERE guild_id=$1
      AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 20`, [guildId,beforeId]);
    return rows.map(r => ({ id: String(r.id), status: String(r.status) }));
  }
  async resolve(guildId: string, id: string, by: string, outcome: Resolution, now: number, cooldownMs: number, retentionDays: number): Promise<boolean> {
    if (!resolutions.includes(outcome)) throw new Error('Invalid resolution');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // Lock jobs first, in the same order as save(), and invalidate in-flight analysis.
      await db.query(`UPDATE review_jobs SET revision=nextval('review_revision'),due_at=$3
        WHERE guild_id=$1 AND author_id=(SELECT author_id FROM moderation_cases WHERE guild_id=$1 AND id=$2 AND status='open')`,
      [guildId,id,new Date(now+cooldownMs)]);
      const result = await db.query(`UPDATE moderation_cases SET status=$3,closed_by=$4,closed_at=$5,updated_at=$5,expires_at=$6
        WHERE guild_id=$1 AND id=$2 AND status='open'`, [guildId,id,outcome,by,new Date(now),new Date(now+retentionDays*86400000)]);
      await db.query('DELETE FROM case_outbox WHERE case_id=$1 AND delivered_at IS NULL AND case_id IN (SELECT id FROM moderation_cases WHERE guild_id=$2 AND status<>\'open\')', [id,guildId]);
      await db.query('COMMIT'); return result.rowCount === 1;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async pendingNotices(guildId: string, now: number): Promise<Notice[]> {
    const { rows } = await this.pool.query(`SELECT o.case_id,o.attempts FROM case_outbox o JOIN moderation_cases c ON c.id=o.case_id
      WHERE c.guild_id=$1 AND c.status='open' AND c.expires_at>$2 AND o.delivered_at IS NULL AND o.attempts<6 AND o.due_at<=$2
      ORDER BY o.due_at,o.case_id LIMIT 5`, [guildId,new Date(now)]);
    return rows.map(r => ({ id: String(r.case_id), attempts: Number(r.attempts) }));
  }
  async beginNotice(guildId: string, notice: Notice, now: number): Promise<boolean> {
    const result = await this.pool.query(`UPDATE case_outbox SET attempts=attempts+1,due_at=$3
      WHERE case_id=$1 AND delivered_at IS NULL AND attempts=$4 AND case_id IN
      (SELECT id FROM moderation_cases WHERE guild_id=$2 AND status='open' AND expires_at>$5)`,
    [notice.id,guildId,new Date(now+retryDelay(notice.attempts)),notice.attempts,new Date(now)]);
    return result.rowCount === 1;
  }
  async delivered(guildId: string, id: string, messageId: string): Promise<void> {
    await this.pool.query(`UPDATE case_outbox SET message_id=$3,delivered_at=now() WHERE case_id=$1
      AND case_id IN (SELECT id FROM moderation_cases WHERE guild_id=$2)`, [id,guildId,messageId]);
  }
  async retryNotice(guildId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE case_outbox SET attempts=1,due_at=now() WHERE case_id=$1 AND delivered_at IS NULL
      AND case_id IN (SELECT id FROM moderation_cases WHERE guild_id=$2 AND status='open')`, [id,guildId]);
    return result.rowCount === 1;
  }
  async stats(guildId: string): Promise<{ queued: number; open: number; failedNotices: number }> {
    const { rows } = await this.pool.query(`SELECT
      (SELECT count(*) FROM review_jobs WHERE guild_id=$1 AND dirty) AS queued,
      (SELECT count(*) FROM moderation_cases WHERE guild_id=$1 AND status='open') AS open,
      (SELECT count(*) FROM case_outbox o JOIN moderation_cases c ON c.id=o.case_id
        WHERE c.guild_id=$1 AND o.delivered_at IS NULL AND o.attempts>=6) AS failed`, [guildId]);
    return { queued: Number(rows[0].queued), open: Number(rows[0].open), failedNotices: Number(rows[0].failed) };
  }
}
