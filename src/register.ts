import { REST, Routes } from 'discord.js';
import { commandDefinitions } from './commands.ts';
import { loadConfig } from './config.ts';
try {
  const config = loadConfig();
  const rest = new REST({ version: '10' }).setToken(config.token);
  // Upsert only our named commands; do not bulk-overwrite another application's commands.
  for (const command of commandDefinitions()) {
    await rest.post(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: command.toJSON() });
  }
  console.log('Registered review, status, and forget commands in the configured guild.');
} catch { console.error('Command registration failed. Check configuration and application access.'); process.exitCode = 1; }
