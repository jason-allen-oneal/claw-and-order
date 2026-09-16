import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Report } from './types.ts';

export function commandDefinitions() {
  const base = (name: string, description: string) => new SlashCommandBuilder().setName(name)
    .setDescription(description).setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return [
    base('review', 'Review a bounded activity sample. Not a verdict.')
      .addUserOption(o => o.setName('member').setDescription('Member to review').setRequired(true))
      .addIntegerOption(o => o.setName('days').setDescription('Observation window, subject to retention').setMinValue(1).setMaxValue(30)),
    base('case', 'Manage automatically opened activity review cases.')
      .addSubcommand(c => c.setName('list').setDescription('List case IDs; details require a permission-filtered review.')
        .addStringOption(o => o.setName('before').setDescription('Older than this case ID').setMaxLength(19)))
      .addSubcommand(c => c.setName('show').setDescription('Review current permitted evidence for a case.')
        .addStringOption(o => o.setName('id').setDescription('Case ID').setRequired(true).setMaxLength(19)))
      .addSubcommand(c => c.setName('resolve').setDescription('Record a moderator decision. No enforcement is performed.')
        .addStringOption(o => o.setName('id').setDescription('Case ID').setRequired(true).setMaxLength(19))
        .addStringOption(o => o.setName('outcome').setDescription('Moderator assessment, not a model label').setRequired(true)
          .addChoices({name:'Dismissed',value:'dismissed'}, {name:'Inconclusive',value:'inconclusive'},
            {name:'Independently confirmed automation',value:'confirmed-automation'})))
      .addSubcommand(c => c.setName('retry-alert').setDescription('Retry an undelivered case notification.')
        .addStringOption(o => o.setName('id').setDescription('Case ID').setRequired(true).setMaxLength(19))),
    base('status', 'Show whether new-message monitoring is on and check process health.'),
    base('forget', 'Erase retained observations for one member. Future activity can still be collected.')
      .addUserOption(o => o.setName('member').setDescription('Member whose retained data will be erased').setRequired(true))
      .addBooleanOption(o => o.setName('confirm').setDescription('Confirm erasing retained observations').setRequired(true)),
  ];
}
export function formatReport(report: Report): string {
  const score = report.heuristicScore === null ? 'not assigned' : `${report.heuristicScore}/100 (not a probability)`;
  const lines = [
    `Claw & Order | ${report.priority}`,
    `Member ID: ${report.subject.authorId}`,
    `Window: ${new Date(report.window.startAt).toISOString()} to ${new Date(report.window.endAt).toISOString()}`,
    `Sample: ${report.sample.messages} messages, ${report.sample.channels} channels. Coverage is partial.`,
    `Heuristic score: ${score}`,
    'Automation probability: unavailable (not calibrated).',
  ];
  if (report.sample.messages === 0) lines.push('No observations available. Check /status, allowed channels, and the review window.');
  for (const signal of report.signals) {
    lines.push('', signal.description, `Alternative: ${signal.alternative}`);
    const messageId = signal.messageIds[0];
    // Full evidence IDs are available in the JSON attachment; no user content is interpolated.
    if (messageId) lines.push(`Evidence message ID: ${messageId}`);
  }
  lines.push('', 'No automatic enforcement. Full evidence IDs and limitations are attached.');
  return lines.join('\n').slice(0, 1900);
}
