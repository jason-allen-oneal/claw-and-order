import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Report } from './types.ts';

export function commandDefinitions() {
  const base = (name: string, description: string) => new SlashCommandBuilder().setName(name)
    .setDescription(description).setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  return [
    base('review', 'Review a bounded activity sample. Not a verdict.')
      .addUserOption(o => o.setName('member').setDescription('Member to review').setRequired(true))
      .addIntegerOption(o => o.setName('days').setDescription('Observation window, subject to retention').setMinValue(1).setMaxValue(30)),
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
