import {
  AttachmentBuilder, Client, Events, GatewayIntentBits, MessageFlags, Options,
  Partials, PermissionFlagsBits,
} from 'discord.js';
import type { ChatInputCommandInteraction, Message } from 'discord.js';
import type { Config } from './config.ts';
import type { Observation } from './types.ts';
import { contentFeatures } from './features.ts';
import { formatReport } from './commands.ts';
import { EventQueue } from './queue.ts';
import { reviewInWorker } from './reviewer.ts';
import { Store } from './store.ts';

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
  const counters = { writeErrors: 0, dropped: 0, disconnects: 0 };
  const queue = new EventQueue(() => { counters.writeErrors++; console.error('Observation write failed.'); });
  let stopping = false;
  let reviewing = false; // Single bounded review worker for this single-process scaffold.
  const enqueue = (task: () => Promise<unknown>) => {
    if (!queue.enqueue(task)) { counters.dropped++; console.error('Observation queue full; event dropped.'); }
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
  client.on(Events.ShardDisconnect, () => { counters.disconnects++; });
  client.on(Events.Error, () => console.error('Discord connection error.'));

  async function handle(interaction: ChatInputCommandInteraction): Promise<void> {
    const authorized = interaction.guildId === config.guildId
      && interaction.channelId === config.moderatorChannelId
      && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!authorized) { await interaction.reply({ content: 'Restricted to authorized reviewers in the configured moderator channel.', flags: MessageFlags.Ephemeral }); return; }
    if (!['review', 'status', 'forget'].includes(interaction.commandName)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === 'status') {
      await store.ping();
      await interaction.editReply(`Claw & Order\nCollection: ${config.collectionEnabled}\nContent signals: ${config.contentSignalsEnabled}\nRetention: ${config.retentionDays} days\nThis process: ${JSON.stringify(counters)}\nProbability: unavailable. Coverage is partial; counters reset on restart.`);
      return;
    }
    const member = interaction.options.getUser('member', true);
    if (interaction.commandName === 'forget') {
      if (!interaction.options.getBoolean('confirm', true)) { await interaction.editReply('No data erased.'); return; }
      let count = 0;
      let erased = false;
      const accepted = queue.enqueue(async () => {
        count = await store.forget(config.guildId, member.id);
        erased = true;
      });
      if (!accepted) { await interaction.editReply('Queue full. No deletion was scheduled; retry.'); return; }
      // Capture failures separately so a failed deletion cannot be reported as success.
      await queue.drain();
      if (!erased) throw new Error('Deletion failed');
      await interaction.editReply(`Deletion processed for retained observations (${count} records). Future activity can still be collected. Message-ID tombstones remain until retention expiry.`);
      return;
    }
    if (member.bot) { await interaction.editReply('Registered bots are excluded; this tool reviews ordinary-account activity.'); return; }
    if (reviewing) { await interaction.editReply('A review is already running. Retry after it completes.'); return; }
    reviewing = true;
    try {
      const days = Math.min(interaction.options.getInteger('days') ?? config.retentionDays, config.retentionDays);
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
      const sample = await store.review(config.guildId, member.id, channels, startAt, endAt, config.maxReviewMessages);
      const report = await reviewInWorker({ guildId: config.guildId, authorId: member.id, startAt, endAt, ...sample });
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
      await interaction.editReply({ content: formatReport(report), files: [attachment], allowedMentions: { parse: [] } });
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
  await store.prune(config.guildId, Date.now() - config.retentionDays * 86400000);
  const cleanup = setInterval(() => enqueue(() => store.prune(config.guildId, Date.now() - config.retentionDays * 86400000)), 3600000);
  cleanup.unref();
  const shutdown = async () => {
    if (stopping) return;
    stopping = true; clearInterval(cleanup); client.destroy();
    await queue.drain(); await store.close();
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  client.once(Events.ClientReady, () => console.log(`Claw & Order ready. Collection enabled: ${config.collectionEnabled}.`));
  try { await client.login(config.token); }
  catch { await shutdown(); throw new Error('Discord login failed'); }
}
