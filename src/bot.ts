import {
  AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, MessageFlags, Options,
  Partials, PermissionFlagsBits,
} from 'discord.js';
import type { ChatInputCommandInteraction, Message } from 'discord.js';
import type { Config } from './config.ts';
import type { Observation } from './types.ts';
import { contentFeatures } from './features.ts';
import { formatReport } from './commands.ts';
import { formatMonitoringStatus } from './status.ts';
import { EventQueue } from './queue.ts';
import { reviewInWorker } from './reviewer.ts';
import { Store } from './store.ts';
import { monitorTick } from './monitor.ts';
import { moderatorOnlyChannel } from './case-access.ts';
import { isCaseId, notificationText } from './case-policy.ts';
import type { Resolution } from './case-policy.ts';
import type { CaseRecord } from './case-store.ts';

export async function startBot(config: Config): Promise<void> {
  const store = new Store(config.databaseUrl);
  await store.ping(); // Migrations are explicit, never silently run by the collector.
  const intents = [GatewayIntentBits.Guilds];
  if (config.collectionEnabled) intents.push(GatewayIntentBits.GuildMessages);
  if (config.contentSignalsEnabled) intents.push(GatewayIntentBits.MessageContent);
  const client = new Client({
    intents, partials: [Partials.Message, Partials.Channel], allowedMentions: { parse: [] },
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }),
  });
  let cleanSince = Date.now();
  const counters = { writeErrors: 0, dropped: 0, disconnects: 0, reviewErrors: 0, notificationErrors: 0 };
  const markGap = () => { cleanSince = Math.max(Date.now(), cleanSince + 1); };
  const queue = new EventQueue(() => { counters.writeErrors++; markGap(); console.error('Observation write failed.'); });
  let stopping = false;
  let reviewing = false; // Single bounded review worker for this single-process scaffold.
  const enqueue = (task: () => Promise<unknown>) => {
    if (!queue.enqueue(task)) { counters.dropped++; markGap(); console.error('Observation queue full; event dropped.'); }
  };
  const inScope = (guildId: string | null, channelId: string) => config.collectionEnabled
    && guildId === config.guildId && config.observedChannelIds.includes(channelId);
  const record = (message: Message) => {
    if (stopping || !inScope(message.guildId, message.channelId) || message.author.bot || message.webhookId || message.system) return;
    const cutoff = Date.now() - config.retentionDays * 86400000;
    if (message.createdTimestamp < cutoff || message.createdTimestamp > Date.now() + 1000) return;
    const features = config.contentSignalsEnabled
      ? contentFeatures(message.content, config.fingerprintSecret, config.guildId, message.author.id)
      : { contentLength: null, fingerprint: null, artifacts: [] };
    const row: Observation = {
      guildId: config.guildId, messageId: message.id, authorId: message.author.id,
      channelId: message.channelId, createdAt: message.createdTimestamp,
      replyToId: message.reference?.channelId === message.channelId ? message.reference.messageId ?? null : null,
      ...features,
    };
    enqueue(() => store.insert(row)); // Closure retains derived fields, not the raw Message.
  };
  client.on(Events.MessageCreate, record);
  // Edits invalidate observations. Never fetch old/new content through an unbounded history path.
  client.on(Events.MessageUpdate, (_, message) => {
    if (inScope(message.guildId, message.channelId)) enqueue(() => store.remove(config.guildId, [message.id]));
  });
  client.on(Events.MessageDelete, message => {
    if (inScope(message.guildId, message.channelId)) enqueue(() => store.remove(config.guildId, [message.id]));
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    if (inScope(channel.guildId, channel.id)) enqueue(() => store.remove(config.guildId, [...messages.keys()]));
  });
  client.on(Events.ShardDisconnect, () => { counters.disconnects++; markGap(); });
  client.on(Events.ShardResume, markGap);
  client.on(Events.ShardReady, markGap);
  client.on(Events.Error, () => console.error('Discord connection error.'));

  async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
    const authorized = interaction.guildId === config.guildId
      && interaction.channelId === config.moderatorChannelId
      && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!authorized) { await interaction.reply({ content: 'Restricted to authorized reviewers in the configured moderator channel.', flags: MessageFlags.Ephemeral }); return; }
    if (!['review', 'case', 'status', 'forget'].includes(interaction.commandName)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === 'status') {
      await store.ping();
      const stats = await store.cases.stats(config.guildId);
      await interaction.editReply(formatMonitoringStatus(config, counters) +
        `\nCases: ${stats.open} open; ${stats.queued} queued members; ${stats.failedNotices} exhausted alerts.\nAutomatic clean window begins: ${new Date(cleanSince).toISOString()}`);
      return;
    }
    let caseRecord: CaseRecord | null = null;
    let memberId: string;
    if (interaction.commandName === 'case') {
      const fresh = await interaction.guild!.members.fetch({ user: interaction.user.id, force: true });
      if (!fresh.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('Reviewer access changed');
      const action = interaction.options.getSubcommand();
      const caseId = interaction.options.getString(action === 'list' ? 'before' : 'id');
      if (caseId !== null && !isCaseId(caseId)) { await interaction.editReply('Invalid case ID.'); return; }
      if (action === 'list') {
        const cases = await store.cases.list(config.guildId, caseId);
        await interaction.editReply(cases.length ? cases.map(c => `Case ${c.id}: ${c.status}`).join('\n') +
          `\nFor older entries: /case list before:${cases[cases.length-1]!.id}` : 'No retained cases.'); return;
      }
      if (!caseId) throw new Error('Missing case ID');
      caseRecord = await store.cases.get(config.guildId, caseId);
      if (!caseRecord) { await interaction.editReply('Case not found or no longer retained.'); return; }
      if (action === 'resolve') {
        const changed = await store.cases.resolve(config.guildId, caseId, interaction.user.id,
          interaction.options.getString('outcome', true) as Resolution, Date.now(), config.caseCooldownHours*3600000, config.retentionDays);
        await interaction.editReply(changed ? `Case ${caseId} resolved. No enforcement performed. Any new case requires fresh post-resolution evidence and the cooldown to expire.` : 'Case is already closed.'); return;
      }
      if (action === 'retry-alert') {
        const changed = await store.cases.retryNotice(config.guildId, caseId);
        await interaction.editReply(changed ? 'Notification queued for retry. Automatic review must be ON to deliver it.' : 'No undelivered alert exists for this open case.'); return;
      }
      memberId = caseRecord.authorId;
    } else {
      const member = interaction.options.getUser('member', true);
      if (member.bot && interaction.commandName === 'review') { await interaction.editReply('Registered bots are excluded; this tool reviews ordinary-account activity.'); return; }
      memberId = member.id;
    }
    if (interaction.commandName === 'forget') {
      if (!interaction.options.getBoolean('confirm', true)) { await interaction.editReply('No data erased.'); return; }
      let count = 0;
      let erased = false;
      const accepted = queue.enqueue(async () => {
        count = await store.forget(config.guildId, memberId);
        erased = true;
      });
      if (!accepted) { await interaction.editReply('Queue full. No deletion was scheduled; retry.'); return; }
      // Capture failures separately so a failed deletion cannot be reported as success.
      await queue.drain();
      if (!erased) throw new Error('Deletion failed');
      await interaction.editReply(`Deletion processed for retained observations (${count} records), case records, and queued alerts. Future activity can still be collected. Message-ID tombstones remain until retention expiry.`);
      return;
    }
    if (reviewing) { await interaction.editReply('A review is already running. Retry after it completes.'); return; }
    reviewing = true;
    try {
      const days = Math.min((caseRecord ? config.retentionDays : interaction.options.getInteger('days')) ?? config.retentionDays, config.retentionDays);
      const guild = interaction.guild!;
      const reviewer = await guild.members.fetch({ user: interaction.user.id, force: true });
      const channels: string[] = [];
      for (const id of config.observedChannelIds) {
        const channel = await guild.channels.fetch(id, { force: true }).catch(() => null);
        if (channel?.permissionsFor(reviewer)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) channels.push(id);
      }
      const endAt = Date.now();
      const startAt = endAt - days * 86400000;
      await queue.drain();
      const sample = await store.review(config.guildId, memberId, channels, startAt, endAt, config.maxReviewMessages);
      if (caseRecord && sample.messages.length === 0) { await interaction.editReply('No retained observations available in your permitted scope.'); return; }
      const report = await reviewInWorker({ guildId: config.guildId, authorId: memberId, startAt, endAt, ...sample });
      if (caseRecord) report.limitations.push(`Case ${caseRecord.id} (${caseRecord.status}). This is a fresh permission-filtered review, not the original case snapshot.`);
      report.limitations.push(`Collector counters for this process only: ${JSON.stringify(counters)}.`);
      const evidence = report.signals.flatMap(signal => signal.messageIds.map(messageId => {
        const row = sample.messages.find(r => r.messageId === messageId)!;
        return { family: signal.family, messageId, url: `https://discord.com/channels/${row.guildId}/${row.channelId}/${row.messageId}` };
      }));
      // Fail closed if permissions changed while the snapshot was being analyzed.
      const freshReviewer = await guild.members.fetch({ user: interaction.user.id, force: true });
      if (!freshReviewer.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('Reviewer access changed');
      for (const id of new Set(sample.messages.map(row => row.channelId))) {
        const channel = await guild.channels.fetch(id, { force: true }).catch(() => null);
        if (!channel?.permissionsFor(freshReviewer)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
          throw new Error('Channel access changed');
        }
      }
      if (counters.dropped > 0 || counters.writeErrors > 0) {
        report.priority = 'insufficient-evidence'; report.heuristicScore = null;
        report.limitations.push('Known collection loss in this process: aggregate scoring withheld.');
      }
      const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify({ ...report, evidence }, null, 2)), { name: 'activity-review.json' });
      await interaction.editReply({ content: (caseRecord ? `Case ${caseRecord.id} | ${caseRecord.status}\n` : '') + formatReport(report), files: [attachment], allowedMentions: { parse: [] } });
    } finally { reviewing = false; }
  }
  client.on(Events.InteractionCreate, interaction => {
    if (!interaction.isChatInputCommand() || stopping) return;
    void handle(interaction).catch(async () => {
      console.error('Command failed. No message content or credentials logged.');
      const content = 'Operation failed. No verdict or successful deletion should be inferred. Check service health and retry.';
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, attachments: [] });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      } catch { console.error('Could not deliver command error.'); }
    });
  });
  async function automaticChannels(): Promise<string[]> {
    const guild = await client.guilds.fetch(config.guildId);
    const me = await guild.members.fetchMe({ force: true });
    const ids: string[] = [];
    for (const id of config.observedChannelIds) {
      const channel = await guild.channels.fetch(id, { force: true }).catch(() => null);
      if (channel?.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) ids.push(id);
    }
    return ids;
  }
  async function notify(id: string, retry: boolean): Promise<string> {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.fetch(config.moderatorChannelId, { force: true });
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Case alerts require a guild text channel');
    const roles = await guild.roles.fetch();
    const me = await guild.members.fetchMe({ force: true });
    const overwrites = [...channel.permissionOverwrites.cache.values()].map(o =>
      ({ id:o.id, type:o.type, allow:o.allow.bitfield, deny:o.deny.bitfield }));
    if (!moderatorOnlyChannel(config.guildId, me.id, overwrites, new Map([...roles].map(([key,role]) => [key,role.permissions.bitfield])))
      || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory])) {
      throw new Error('Case channel privacy or bot permissions failed');
    }
    const content = notificationText(id);
    // Reconcile a prior send whose acknowledgement may have been lost.
    if (retry) {
      const recent = await channel.messages.fetch({ limit: 100, cache: false });
      const existing = recent.find(m => m.author.id === me.id && m.content === content);
      if (existing) return existing.id;
    }
    const message = await channel.send({ content, allowedMentions: { parse: [] }, nonce: `c:${id}`, enforceNonce: true });
    return message.id;
  }
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let autoFlight: Promise<void> = Promise.resolve();
  let cleanup: ReturnType<typeof setInterval> | undefined;
  function scheduleAuto(): void {
    if (stopping || !config.autoReviewEnabled) return;
    autoTimer = setTimeout(() => {
      autoFlight = runAuto().finally(scheduleAuto);
    }, config.autoReviewTickSeconds*1000);
    autoTimer.unref();
  }
  async function runAuto(): Promise<void> {
    if (stopping || !client.isReady() || reviewing) return;
    reviewing = true;
    try {
      await queue.drain();
      await monitorTick(store, config, { cleanSince: () => cleanSince, channels: automaticChannels,
        review: reviewInWorker, notify,
        error: kind => { if (kind === 'review') counters.reviewErrors++; else counters.notificationErrors++; }
      });
    } catch { counters.reviewErrors++; console.error('Automatic review cycle failed; retained work will be retried.'); }
    finally { reviewing = false; }
  }
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true; clearInterval(cleanup); clearTimeout(autoTimer);
    await autoFlight; client.destroy();
    await queue.drain(); await store.close();
  }
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  client.once(Events.ClientReady, () => {
    markGap();
    console.log(`Claw & Order ready. Monitoring: ${config.collectionEnabled}. Automatic cases: ${config.autoReviewEnabled}.`);
    scheduleAuto();
  });
  try {
    // One process per guild, across hosts. Losing the lock shuts this process down.
    await store.acquireCollectorLock(config.guildId, () => { void shutdown(); });
    await store.prune(config.guildId, Date.now() - config.retentionDays * 86400000);
    if (config.autoReviewEnabled) await store.cases.seed(config.guildId, Date.now() - config.retentionDays*86400000);
    cleanup = setInterval(() => enqueue(() => store.prune(config.guildId, Date.now() - config.retentionDays*86400000)), 3600000);
    cleanup.unref();
    await client.login(config.token);
  } catch { await shutdown(); throw new Error('Startup failed. Check migrations, configuration, credentials, and collector lock.'); }
}
