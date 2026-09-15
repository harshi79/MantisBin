/**
 * Manual expiration sweep (the same code the Worker cron runs):
 *   npm run clean-expired
 * Useful for verifying cleanup locally or running it from CI/external cron.
 */

import { runMaintenance } from '../src/lib/maintenance.js';
import { ensureSchema } from '../src/db/schema.js';
import { createDb, loadEnv } from './dev.js';

const env = await loadEnv();
const db = await createDb(env);
await ensureSchema(db);
const summary = await runMaintenance(db);
console.log(JSON.stringify(summary, null, 2));
await db.close?.();
