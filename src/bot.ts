import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client,
  Events, GatewayIntentBits, MessageFlags, Options, Partials, PermissionFlagsBits,
} from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction, Message } from 'discord.js';
import type { Config } from './config.ts';
import type { Observation } from './types.ts';
import { contentFeatures, conversationalText } from './features.ts';
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
import { createSemanticScorer, type SemanticScorer } from './semantic.ts';
import { startHealthServer } from './health.ts';

export async function startBot(config: Config): Promise<void> {
  const store = new Store(config.databaseUrl);
  await store.ping(); // Migrations are explicit, never silently run by the collector.
  const semanticScorer: SemanticScorer | null = config.semanticEnabled
    ? await createSemanticScorer({ modelPath: config.semanticModelPath, prototypes: [
      { label: 'conversational ai assistant', polarity: 'positive', text: 'A helpful AI chatbot politely answers questions with detailed explanations, comprehensive suggestions, and courteous offers of assistance.' },
      { label: 'structured assistant response', polarity: 'positive', text: 'An automated assistant writes a polished, structured response with headings, numbered steps, a concise summary, and a status report.' },
      { label: 'automated task report', polarity: 'positive', text: 'A software agent executes a task, calls tools or APIs, and reports the result in a deterministic operational format.' },
      { label: 'procedural service reply', polarity: 'positive', text: 'An automated service responds to a request with procedural instructions, remediation steps, and a completion status.' },
      { label: 'autonomous self-bot response', polarity: 'positive', text: 'An automated Discord self-bot or AI puppet responds automatically to user queries with step-by-step guides, recommendations, and polite disclaimers.' },
      { label: 'informal human conversation', polarity: 'negative', text: 'A human casually chats with another person, shares personal opinions or experiences, asks questions, jokes, and responds informally.' },
      { label: 'spontaneous human reply', polarity: 'negative', text: 'A person writes a spontaneous conversational reply with varied wording, emotion, typos, uncertainty, and natural interruptions.' },
      { label: 'human back-and-forth', polarity: 'negative', text: 'A human discussion contains informal back-and-forth rather than a polished report or procedure.' },
      { label: 'casual chat and slang', polarity: 'negative', text: 'Short casual chat messages with slang, internet abbreviations like idk or lol, fragmented thoughts, and quick reactions.' },
      { label: 'gaming and community banter', polarity: 'negative', text: 'Casual server banter about games, music, streams, and daily life with emojis, all-lowercase text, and brief remarks.' },
    ] })
    : null;
  const intents = [GatewayIntentBits.Guilds];
  if (config.collectionEnabled) {
    intents.push(GatewayIntentBits.GuildMessages);
    intents.push(GatewayIntentBits.GuildMessageTyping);
  }
  if (config.contentSignalsEnabled || config.semanticEnabled) intents.push(GatewayIntentBits.MessageContent);
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
  const isObserved = (channelId: string, parentId?: string | null): boolean => {
    if (config.observedChannelIds.includes(channelId)) return true;
    if (parentId && config.observedChannelIds.includes(parentId)) return true;
    return false;
  };
  const inScope = (guildId: string | null, channelId: string, parentId?: string | null) =>
    config.collectionEnabled && guildId === config.guildId && isObserved(channelId, parentId);

  const recentTyping = new Map<string, number>();
  client.on(Events.TypingStart, typing => {
    const parentId = typing.channel?.isThread?.() && 'parentId' in typing.channel ? typing.channel.parentId : null;
    if (typing.guild?.id === config.guildId && isObserved(typing.channel.id, parentId)) {
      recentTyping.set(`${typing.channel.id}:${typing.user.id}`, typing.startedTimestamp || Date.now());
    }
  });
  const enqueue = (task: () => Promise<unknown>): boolean => {
    if (!queue.enqueue(task)) { counters.dropped++; markGap(); console.error('Observation queue full; event dropped.'); return false; }
    return true;
  };
  const captureMessage = (message: Message, startAt: number, endAt: number): boolean => {
    const isThread = message.channel?.isThread?.() ?? false;
    const parentId = isThread && 'parentId' in message.channel ? message.channel.parentId : null;
    if (stopping || !inScope(message.guildId, message.channelId, parentId) ||
      (!config.captureBotMessages && message.author.bot) || message.webhookId || message.system) return false;
    if (message.createdTimestamp < startAt || message.createdTimestamp > endAt) return false;
    const effectiveChannelId = (isThread && parentId && config.observedChannelIds.includes(parentId))
      ? parentId
      : message.channelId;
    const typingKey = `${message.channelId}:${message.author.id}`;
    const lastTyped = recentTyping.get(typingKey);
    const isLive = Math.abs(Date.now() - message.createdTimestamp) < 30000;
    const untyped = isLive && (!lastTyped || (message.createdTimestamp - lastTyped > 15000));
    const hasMedia = (message.attachments?.size ?? 0) > 0 || (message.stickers?.size ?? 0) > 0;
    const features = config.contentSignalsEnabled
      ? contentFeatures(message.content, config.fingerprintSecret, config.guildId, message.author.id, { untyped, hasMedia })
      : { contentLength: null, fingerprint: null, artifacts: [] };
    const row: Observation = {
      guildId: config.guildId, messageId: message.id, authorId: message.author.id,
      channelId: effectiveChannelId, createdAt: message.createdTimestamp,
      replyToId: message.reference?.channelId === message.channelId ? message.reference.messageId ?? null : null,
      ...features,
    };
    const content = conversationalText(message.content);
    return enqueue(async () => {
      const semantic = semanticScorer && content ? await semanticScorer.score(content) : null;
      await store.insert({ ...row, semantic });
    }); // Closure retains message text only until local inference and persistence finish.
  };
  const record = (message: Message) => {
    const endAt = Date.now() + 1000;
    captureMessage(message, endAt - config.retentionDays * 86400000, endAt);
  };
  client.on(Events.MessageCreate, record);
  // Edits invalidate observations. Never fetch old/new content through an unbounded history path.
  client.on(Events.MessageUpdate, (_, message) => {
    const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
    if (inScope(message.guildId, message.channelId, parentId)) enqueue(() => store.remove(config.guildId, [message.id]));
  });
  client.on(Events.MessageDelete, message => {
    const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
    if (inScope(message.guildId, message.channelId, parentId)) enqueue(() => store.remove(config.guildId, [message.id]));
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    const parentId = channel?.isThread?.() ? channel.parentId : null;
    if (inScope(channel.guildId, channel.id, parentId)) enqueue(() => store.remove(config.guildId, [...messages.keys()]));
  });
  client.on(Events.ShardDisconnect, () => { counters.disconnects++; markGap(); });
  client.on(Events.ShardResume, markGap);
  client.on(Events.ShardReady, markGap);
  client.on(Events.Error, () => console.error('Discord connection error.'));

  async function backfillMember(memberId: string, startAt: number, endAt: number, channelIds: string[], limit: number): Promise<{ fetched: number; matched: number; queued: number; truncated: boolean; errors: number }> {
    let fetched = 0; let matched = 0; let queued = 0; let errors = 0; let truncated = false;
    const maxPages = Math.ceil(limit / 100);
    const seenParents = new Set<string>();
    for (const channelId of channelIds) {
      const channel = await client.channels.fetch(channelId, { force: true }).catch(() => null);
      if (!channel?.isTextBased() || !('messages' in channel)) continue;
      let before: string | undefined;
      for (let page = 0; page < maxPages && fetched < limit; page++) {
        let messages;
        try {
          messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        } catch { errors++; break; }
        if (messages.size === 0) break;
        fetched += messages.size;
        for (const message of messages.values()) {
          if (message.createdTimestamp < startAt) { before = undefined; break; }
          if (message.author.id === memberId) {
            matched++;
            // Fetch referenced parent message so reply latency can be computed
            if (message.reference?.messageId && message.reference.channelId === message.channelId) {
              const parentId = message.reference.messageId;
              if (!seenParents.has(parentId)) {
                seenParents.add(parentId);
                let parent = messages.get(parentId);
                if (!parent) {
                  parent = await channel.messages.fetch(parentId).catch(() => undefined);
                }
                if (parent) {
                  captureMessage(parent, startAt - 86400000, endAt);
                }
              }
            }
            if (captureMessage(message, startAt, endAt)) queued++;
          }
        }
        const oldest = messages.last();
        if (!oldest || oldest.createdTimestamp <= startAt || messages.size < 100) break;
        before = oldest.id;
      }
      if (fetched >= limit) { truncated = true; break; }
    }
    return { fetched, matched, queued, truncated, errors };
  }

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
      const backfill = interaction.commandName === 'review' && interaction.options.getBoolean('backfill') === true;
      let backfillResult: Awaited<ReturnType<typeof backfillMember>> | null = null;
      if (backfill) {
        backfillResult = await backfillMember(memberId, startAt, endAt, channels, config.maxReviewMessages);
        await queue.drain();
      }
      await queue.drain();
      const sample = await store.review(config.guildId, memberId, channels, startAt, endAt, config.maxReviewMessages);
      if (caseRecord && sample.messages.length === 0) { await interaction.editReply('No retained observations available in your permitted scope.'); return; }
      const report = await reviewInWorker({ guildId: config.guildId, authorId: memberId, startAt, endAt, ...sample,
        // Manual reviews are exploratory; automatic case creation retains the conservative analyzer gate.
        scoreGate: { minMessages: 1, minSpanMs: 0 } });
      if (caseRecord) report.limitations.push(`Case ${caseRecord.id} (${caseRecord.status}). This is a fresh permission-filtered review, not the original case snapshot.`);
      report.limitations.push(`Collector counters for this process only: ${JSON.stringify(counters)}.`);
      if (backfillResult) report.limitations.push(`History backfill: fetched ${backfillResult.fetched}, matched ${backfillResult.matched}, queued ${backfillResult.queued}; ${backfillResult.errors} channel fetch errors${backfillResult.truncated ? '; fetch cap reached' : ''}. Raw message content was scored transiently and not stored.`);
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
      const components: ActionRowBuilder<ButtonBuilder>[] = [];
      if (caseRecord && caseRecord.status === 'open') {
        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`claw:resolve:${caseRecord.id}:dismissed`).setLabel('Dismiss (Safe)').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`claw:resolve:${caseRecord.id}:inconclusive`).setLabel('Inconclusive').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`claw:resolve:${caseRecord.id}:confirmed-automation`).setLabel('Confirm Automation').setStyle(ButtonStyle.Danger),
        ));
      }
      await interaction.editReply({
        content: (caseRecord ? `Case ${caseRecord.id} | ${caseRecord.status}\n` : '') + formatReport(report),
        files: [attachment],
        components,
        allowedMentions: { parse: [] },
      });
    } finally { reviewing = false; }
  }

  async function handleButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'claw') return;
    const action = parts[1];
    const caseId = parts[2];
    if (!caseId || !isCaseId(caseId)) return;
    const member = await interaction.guild?.members.fetch({ user: interaction.user.id, force: true }).catch(() => null);
    if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'You need Manage Server permissions to act on cases.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'resolve') {
      const outcome = parts[3] as Resolution;
      if (!['dismissed', 'inconclusive', 'confirmed-automation'].includes(outcome)) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const changed = await store.cases.resolve(config.guildId, caseId, interaction.user.id,
        outcome, Date.now(), config.caseCooldownHours * 3600000, config.retentionDays);
      if (changed) {
        await interaction.editReply(`Case \`${caseId}\` marked as **${outcome}** by <@${interaction.user.id}>. Cooldown active for ${config.caseCooldownHours} hours.`);
      } else {
        await interaction.editReply(`Case \`${caseId}\` is already closed or does not exist.`);
      }
    } else if (action === 'show') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const caseRecord = await store.cases.get(config.guildId, caseId);
      if (!caseRecord) {
        await interaction.editReply(`Case \`${caseId}\` does not exist.`);
        return;
      }
      const days = config.retentionDays;
      const guild = interaction.guild!;
      const channels: string[] = [];
      for (const cid of config.observedChannelIds) {
        const ch = await guild.channels.fetch(cid, { force: true }).catch(() => null);
        if (ch?.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) channels.push(cid);
      }
      const endAt = Date.now();
      const startAt = endAt - days * 86400000;
      const sample = await store.review(config.guildId, caseRecord.authorId, channels, startAt, endAt, config.maxReviewMessages);
      const report = await reviewInWorker({
        guildId: config.guildId, authorId: caseRecord.authorId, startAt, endAt, ...sample,
        scoreGate: { minMessages: 1, minSpanMs: 0 },
      });
      report.limitations.push(`Case ${caseRecord.id} (${caseRecord.status}). Ephemeral evidence review requested via button.`);
      const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(report, null, 2)), { name: `case-${caseId}-review.json` });
      const row = caseRecord.status === 'open' ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`claw:resolve:${caseId}:dismissed`).setLabel('Dismiss (Safe)').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`claw:resolve:${caseId}:inconclusive`).setLabel('Inconclusive').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`claw:resolve:${caseId}:confirmed-automation`).setLabel('Confirm Automation').setStyle(ButtonStyle.Danger),
      )] : [];
      await interaction.editReply({
        content: `Case ${caseRecord.id} | ${caseRecord.status}\n` + formatReport(report),
        files: [attachment],
        components: row,
        allowedMentions: { parse: [] },
      });
    }
  }

  client.on(Events.InteractionCreate, interaction => {
    if (stopping) return;
    if (interaction.isButton()) {
      void handleButton(interaction).catch(async (error) => {
        console.error('Button action failed.', error);
        try {
          if (interaction.deferred || interaction.replied) await interaction.editReply({ content: 'Action failed. Check service health.' });
          else await interaction.reply({ content: 'Action failed.', flags: MessageFlags.Ephemeral });
        } catch { console.error('Could not deliver button error.'); }
      });
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    void handle(interaction).catch(async (error) => {
      console.error('Command failed.', error);
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
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`claw:show:${id}`).setLabel('Review Evidence').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`claw:resolve:${id}:dismissed`).setLabel('Dismiss (Safe)').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`claw:resolve:${id}:confirmed-automation`).setLabel('Confirm Automation').setStyle(ButtonStyle.Danger),
    );
    // Reconcile a prior send whose acknowledgement may have been lost.
    if (retry) {
      const recent = await channel.messages.fetch({ limit: 100, cache: false });
      const existing = recent.find(m => m.author.id === me.id && m.content === content);
      if (existing) return existing.id;
    }
    const message = await channel.send({ content, components: [row], allowedMentions: { parse: [] }, nonce: `c:${id}`, enforceNonce: true });
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
  let healthServer: { close: () => Promise<void> } | null = null;
  if (config.healthPort) {
    healthServer = startHealthServer(config.healthPort, async () => {
      let dbStatus: 'connected' | 'error' = 'connected';
      try { await store.ping(); } catch { dbStatus = 'error'; }
      return {
        status: dbStatus === 'connected' && client.isReady() ? 'ok' : 'degraded',
        uptimeSeconds: Math.floor(process.uptime()),
        database: dbStatus,
        discord: { ready: client.isReady(), pingMs: client.ws.ping },
        counters,
      };
    });
  }
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true; clearInterval(cleanup); clearTimeout(autoTimer);
    if (healthServer) await healthServer.close();
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
    cleanup = setInterval(() => enqueue(() => {
      const now = Date.now();
      for (const [k, t] of recentTyping) if (now - t > 60000) recentTyping.delete(k);
      return store.prune(config.guildId, now - config.retentionDays * 86400000);
    }), 3600000);
    cleanup.unref();
    await client.login(config.token);
  } catch (error) { await shutdown(); console.error('Bot startup error:', error); throw new Error('Startup failed. Check migrations, configuration, credentials, and collector lock.'); }
}
