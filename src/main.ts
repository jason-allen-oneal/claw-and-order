import { loadConfig } from './config.ts';
import { startBot } from './bot.ts';
try { await startBot(loadConfig()); }
catch (error) { console.error('Startup failed. Check configuration, database migration, and Discord access.', error); process.exitCode = 1; }
