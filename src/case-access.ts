// Discord permission bit values. Kept independent of the client for offline tests.
const VIEW = 1024n; const MANAGE_GUILD = 32n; const ADMINISTRATOR = 8n;
export interface ChannelOverwrite { id: string; type: number; allow: bigint; deny: bigint }
export function moderatorOnlyChannel(guildId: string, botId: string, overwrites: ChannelOverwrite[], roles: ReadonlyMap<string, bigint>): boolean {
  const everyone = overwrites.find(o => o.id === guildId && o.type === 0);
  if (!everyone || (everyone.deny & VIEW) === 0n || (everyone.allow & VIEW) !== 0n) return false;
  for (const o of overwrites) {
    if ((o.allow & VIEW) === 0n) continue;
    if (o.type === 1) { if (o.id !== botId) return false; }
    else if (o.type !== 0 || ((roles.get(o.id) ?? 0n) & (MANAGE_GUILD | ADMINISTRATOR)) === 0n) return false;
  }
  return true;
}
