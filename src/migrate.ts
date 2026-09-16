import { Store } from './store.ts';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const store = new Store(url);
try { await store.migrate(); console.log('Database migration complete.'); }
catch { console.error('Database migration failed.'); process.exitCode = 1; }
finally { await store.close(); }
