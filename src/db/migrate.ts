import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import { db, pool } from './index';

/** Applies all SQL migrations in /drizzle. Safe to run on every deploy. */
export async function runMigrations() {
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
}

if (require.main === module) {
  runMigrations()
    .then(() => { console.log('✅ Database is up to date'); return pool.end(); })
    .catch((e) => { console.error('❌ Migration failed', e); process.exit(1); });
}
