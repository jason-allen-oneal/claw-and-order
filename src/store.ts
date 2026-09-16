import pg from 'pg';
import { readFile } from 'node:fs/promises';
import type { Observation, ReviewMessage } from './types.ts';
import { CaseStore } from './case-store.ts';
import { validSketch } from './similarity.ts';
const { Pool } = pg;

export class Store {
  private pool: pg.Pool;
  readonly cases: CaseStore;
  private collectorLock: pg.PoolClient | null = null;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    this.cases = new CaseStore(this.pool);
    // Do not serialize connection errors: they can contain credentials or query details.
    this.pool.on('error', () => console.error('Database connection error.'));
  }
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(719452831)');
      for (const name of ['001_init.sql', '002_similarity.sql', '003_cases.sql', '004_semantic.sql']) {
        const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
          .catch(() => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
        await client.query(sql);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async insert(row: Observation): Promise<void> {
    await this.pool.query(`WITH inserted AS (INSERT INTO observations
      (guild_id,message_id,author_id,channel_id,created_at,reply_to_id,content_length,fingerprint,artifacts,similarity,semantic)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM removed_messages WHERE guild_id=$1 AND message_id=$2)
      ON CONFLICT (guild_id,message_id) DO UPDATE SET
        semantic = CASE WHEN observations.semantic IS NULL THEN EXCLUDED.semantic ELSE observations.semantic END,
        content_length = COALESCE(observations.content_length, EXCLUDED.content_length),
        fingerprint = COALESCE(observations.fingerprint, EXCLUDED.fingerprint),
        artifacts = CASE WHEN observations.artifacts = '[]'::jsonb THEN EXCLUDED.artifacts ELSE observations.artifacts END,
        similarity = COALESCE(observations.similarity, EXCLUDED.similarity)
        WHERE observations.semantic IS NULL AND EXCLUDED.semantic IS NOT NULL
        RETURNING guild_id,author_id)
      INSERT INTO review_jobs(guild_id,author_id) SELECT guild_id,author_id FROM inserted
      ON CONFLICT (guild_id,author_id) DO UPDATE SET dirty=true,revision=nextval('review_revision'),touched_at=now()`, [
      row.guildId, row.messageId, row.authorId, row.channelId, new Date(row.createdAt),
      row.replyToId, row.contentLength, row.fingerprint, JSON.stringify(row.artifacts),
      validSketch(row.similarity) ? JSON.stringify(row.similarity) : null,
      row.semantic ? JSON.stringify(row.semantic) : null,
    ]);
  }
  async remove(guildId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO removed_messages (guild_id,message_id)
        SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [guildId, ids]);
      await client.query(`INSERT INTO review_jobs(guild_id,author_id)
        SELECT DISTINCT guild_id,author_id FROM observations WHERE guild_id=$1
        AND (message_id=ANY($2::text[]) OR reply_to_id=ANY($2::text[]))
        ON CONFLICT(guild_id,author_id) DO UPDATE SET dirty=true,revision=nextval('review_revision'),touched_at=now()`, [guildId,ids]);
      await client.query('DELETE FROM observations WHERE guild_id=$1 AND message_id=ANY($2::text[])', [guildId, ids]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async review(guildId: string, authorId: string, channelIds: string[], startAt: number, endAt: number, limit: number): Promise<{ messages: ReviewMessage[]; truncated: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid review limit');
    const result = await this.pool.query(`SELECT m.*,
      CASE WHEN p.author_id <> m.author_id AND p.created_at <= m.created_at
      THEN EXTRACT(EPOCH FROM (m.created_at-p.created_at))*1000 ELSE NULL END AS latency
      FROM observations m LEFT JOIN observations p ON p.guild_id=m.guild_id
        AND p.channel_id=m.channel_id AND p.message_id=m.reply_to_id
      WHERE m.guild_id=$1 AND m.author_id=$2 AND m.channel_id=ANY($3::text[])
        AND m.created_at >= $4 AND m.created_at <= $5
      ORDER BY m.created_at DESC, m.message_id DESC LIMIT $6`,
    [guildId, authorId, channelIds, new Date(startAt), new Date(endAt), limit + 1]);
    return {
      truncated: result.rows.length > limit,
      messages: result.rows.slice(0, limit).map(r => ({
        guildId: String(r.guild_id), messageId: String(r.message_id), authorId: String(r.author_id),
        channelId: String(r.channel_id), createdAt: new Date(r.created_at as string).getTime(),
        replyToId: r.reply_to_id as string | null, contentLength: r.content_length as number | null,
        fingerprint: r.fingerprint as string | null, artifacts: r.artifacts as Observation['artifacts'],
        replyLatencyMs: r.latency === null ? null : Number(r.latency),
        similarity: validSketch(r.similarity) ? r.similarity : null,
        semantic: r.semantic ?? null,
      })),
    };
  }
  async forget(guildId: string, authorId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM review_jobs WHERE guild_id=$1 AND author_id=$2', [guildId,authorId]);
      await client.query('DELETE FROM moderation_cases WHERE guild_id=$1 AND author_id=$2', [guildId,authorId]);
      // Reevaluate replies by other members whose measured parent is being erased.
      await client.query(`UPDATE review_jobs SET dirty=true,revision=nextval('review_revision'),touched_at=now()
        WHERE guild_id=$1 AND author_id<>$2 AND author_id IN (SELECT child.author_id FROM observations child
        JOIN observations parent ON parent.guild_id=child.guild_id AND parent.channel_id=child.channel_id
        AND parent.message_id=child.reply_to_id WHERE parent.guild_id=$1 AND parent.author_id=$2)`, [guildId,authorId]);
      const result = await client.query(`WITH removed AS (
        DELETE FROM observations WHERE guild_id=$1 AND author_id=$2 RETURNING guild_id,message_id
      ) INSERT INTO removed_messages(guild_id,message_id) SELECT guild_id,message_id FROM removed ON CONFLICT DO NOTHING`, [guildId,authorId]);
      await client.query('COMMIT'); return result.rowCount ?? 0;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async prune(guildId: string, cutoff: number): Promise<void> {
    await this.pool.query('DELETE FROM moderation_cases WHERE guild_id=$1 AND expires_at<=now()', [guildId]);
    await this.pool.query('DELETE FROM review_jobs WHERE guild_id=$1 AND touched_at < $2', [guildId,new Date(cutoff)]);
    await this.pool.query('DELETE FROM observations WHERE guild_id=$1 AND created_at < $2', [guildId, new Date(cutoff)]);
    await this.pool.query('DELETE FROM removed_messages WHERE guild_id=$1 AND removed_at < $2', [guildId, new Date(cutoff)]);
  }
  async ping(): Promise<void> { await this.pool.query('SELECT 1'); }
  async acquireCollectorLock(guildId: string, onLoss: () => void): Promise<void> {
    if (this.collectorLock) throw new Error('Collector already locked');
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,719452831)) AS locked', [guildId]);
      if (!result.rows[0]?.locked) throw new Error('Another collector is active for this guild');
      this.collectorLock = client;
      client.on('error', onLoss);
    } catch (error) { client.release(true); throw error; }
  }
  async close(): Promise<void> {
    if (this.collectorLock) { this.collectorLock.release(true); this.collectorLock = null; }
    await this.pool.end();
  }
}
