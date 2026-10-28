import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { env } from '../config/env';
import { db, pool, schema } from './index';
import { runMigrations } from './migrate';
import { AUTO_RULES, CANNED, CATALOGUE, COUPONS, PLANS, ROLE_PERMS, SETTINGS } from './defaults';

/** Creates plans, roles, lists, settings and the first Super Admin. Safe to run more than once. */
export async function seed() {
  for (const p of PLANS) {
    const { prices, ...plan } = p;
    await db.insert(schema.plans).values(plan).onConflictDoNothing();
    for (const pr of prices) await db.insert(schema.planPrices).values({ planId: p.id, ...pr }).onConflictDoNothing();
  }
  for (const [role, modules] of Object.entries(ROLE_PERMS)) await db.insert(schema.rolePermissions).values({ role, modules }).onConflictDoNothing();
  for (const [list, names] of Object.entries(CATALOGUE)) {
    await db.insert(schema.catalogueItems).values(names.map((name, order) => ({ list, name, order }))).onConflictDoNothing();
  }
  for (const c of COUPONS) await db.insert(schema.coupons).values(c).onConflictDoNothing();
  for (const r of AUTO_RULES) await db.insert(schema.autoRules).values(r).onConflictDoNothing();
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.cannedReplies);
  if (!count) await db.insert(schema.cannedReplies).values(CANNED);
  for (const [key, value] of Object.entries(SETTINGS)) await db.insert(schema.settings).values({ key, value }).onConflictDoNothing();
  await db.insert(schema.admins).values({ name: env.SEED_ADMIN_NAME, email: env.SEED_ADMIN_EMAIL.toLowerCase(), passwordHash: await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 10), role: 'Super Admin', status: 'ACTIVE' }).onConflictDoNothing();
}

if (require.main === module) {
  runMigrations()
    .then(seed)
    .then(() => { console.log(env.NODE_ENV === 'production' ? `✅ Seeded. Admin login: ${env.SEED_ADMIN_EMAIL} (password from SEED_ADMIN_PASSWORD)` : `✅ Seeded. Admin login: ${env.SEED_ADMIN_EMAIL} / ${env.SEED_ADMIN_PASSWORD} — change this password after first login.`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
