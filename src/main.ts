import { loadConfig } from './config.ts';
import { startBot } from './bot.ts';
try { await startBot(loadConfig()); }
catch { console.error('Startup failed. Check configuration, database migration, and Discord access.'); process.exitCode = 1; }
