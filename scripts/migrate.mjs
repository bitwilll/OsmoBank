/* One-shot schema + seed for the configured database.
 *
 * Run once after provisioning Turso, with the connection + seed env set:
 *   TURSO_DATABASE_URL=libsql://<db>.turso.io \
 *   TURSO_AUTH_TOKEN=<token> \
 *   OSMO_ADMIN_PASS=<pick-one> OSMO_MANAGER_PASS=<pick-one> \
 *   npm run db:migrate
 *
 * Idempotent: tables use CREATE TABLE IF NOT EXISTS and the seed only runs on an
 * empty users table, so re-running is safe. */
import { initDb } from '../server/db.js';

try {
  await initDb();
  console.log('✅ OsmoBank schema applied' + (process.env.OSMO_SEED === '0' ? '' : ' + seed ensured') + '.');
  process.exit(0);
} catch (e) {
  console.error('❌ Migration failed:', e?.message || e);
  process.exit(1);
}
