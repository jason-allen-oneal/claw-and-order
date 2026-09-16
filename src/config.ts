export interface Config {
  token: string;
  applicationId: string;
  guildId: string;
  moderatorChannelId: string;
  observedChannelIds: string[];
  databaseUrl: string;
  collectionEnabled: boolean;
  contentSignalsEnabled: boolean;
  fingerprintSecret: string;
  retentionDays: number;
  maxReviewMessages: number;
}
const snowflake = /^\d{17,20}$/;
export function isSnowflake(value: string): boolean { return snowflake.test(value); }
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
function id(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key);
  if (!isSnowflake(value)) throw new Error(`${key} must be a Discord ID`);
  return value;
}
function bool(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key]?.trim() ?? 'false';
  if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`);
  return value === 'true';
}
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${key} must be ${min}..${max}`);
  return value;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const collectionEnabled = bool(env, 'COLLECTION_ENABLED');
  const contentSignalsEnabled = bool(env, 'CONTENT_SIGNALS_ENABLED');
  const acknowledged = bool(env, 'POLICY_REVIEW_ACKNOWLEDGED');
  if (collectionEnabled && !acknowledged) throw new Error('Live collection requires POLICY_REVIEW_ACKNOWLEDGED=true');
  if (contentSignalsEnabled && !collectionEnabled) throw new Error('Content signals require collection');
  const observedChannelIds = [...new Set((env.OBSERVED_CHANNEL_IDS ?? '').split(',').map(v => v.trim()).filter(Boolean))];
  if (observedChannelIds.some(value => !isSnowflake(value))) throw new Error('Invalid OBSERVED_CHANNEL_IDS');
  if (observedChannelIds.length > 100) throw new Error('At most 100 observed channels are supported');
  if (collectionEnabled && observedChannelIds.length === 0) throw new Error('Live collection requires an explicit channel allowlist');
  const fingerprintSecret = env.FINGERPRINT_SECRET ?? '';
  if (contentSignalsEnabled && Buffer.byteLength(fingerprintSecret) < 32) throw new Error('FINGERPRINT_SECRET must be at least 32 bytes');
  const databaseUrl = required(env, 'DATABASE_URL');
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL is invalid'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const moderatorChannelId = id(env, 'MODERATOR_CHANNEL_ID');
  if (observedChannelIds.includes(moderatorChannelId)) throw new Error('Do not collect the moderator review channel');
  return {
    token: required(env, 'DISCORD_TOKEN'), applicationId: id(env, 'DISCORD_APPLICATION_ID'),
    guildId: id(env, 'DISCORD_GUILD_ID'), moderatorChannelId, observedChannelIds, databaseUrl,
    collectionEnabled, contentSignalsEnabled, fingerprintSecret,
    retentionDays: integer(env, 'RETENTION_DAYS', 7, 1, 30),
    maxReviewMessages: integer(env, 'MAX_REVIEW_MESSAGES', 2000, 20, 10000),
  };
}
