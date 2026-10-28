import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { logger } from './logger';
import { sendBulkTextSms } from './sms';
import { emitToUser } from '../realtime';
import { brandName } from '../lib/brand';

/** In-app notification for one member (+ live push to open apps). */
export async function notify(userId: string, type: string, title: string, body = '', link?: string) {
  try {
    const [n] = await db.insert(schema.notifications).values({ userId, type, title, body, link }).returning();
    emitToUser(userId, 'notification', n);
  } catch (err) {
    logger.warn({ err, userId, type }, 'notify failed');
  }
}

/** "Hi {name}" + { name: 'Ravi' } → "Hi Ravi". Unknown placeholders are left empty. */
export const fill = (tpl: string, vars: Record<string, string | number | undefined | null>) =>
  tpl.replace(/\{(\w+)\}/g, (_m, k: string) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));

/** Members who switched SMS off (Settings → Notifications) don't get texts. */
async function smsPhones(ids: string[]) {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db.select({ phone: schema.users.phone }).from(schema.users)
      .where(and(inArray(schema.users.id, ids.slice(i, i + 1000)), eq(schema.users.status, 'ACTIVE'), sql`coalesce((${schema.users.prefs}->>'sms')::boolean, true)`));
    out.push(...rows.map((r) => r.phone));
  }
  return out;
}

/**
 * Sends a message using an Auto-messages rule (Admin → Engage → Auto messages).
 * In-app always; SMS too when the rule has the "sms" channel on. Does nothing if the rule is off.
 */
export async function notifyRule(key: string, userIds: string | string[], vars: Record<string, string | number | undefined | null>, link?: string) {
  const ids = [...new Set(Array.isArray(userIds) ? userIds : [userIds])];
  if (!ids.length) return 0;
  const rule = await db.query.autoRules.findFirst({ where: eq(schema.autoRules.key, key) });
  if (!rule || !rule.enabled) return 0;
  const body = fill(rule.template, vars);
  try {
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await db.insert(schema.notifications).values(ids.slice(i, i + 1000).map((userId) => ({ userId, type: key, title: rule.name, body, link }))).returning();
      for (const n of rows) emitToUser(n.userId, 'notification', n);
    }
    await db.update(schema.autoRules).set({ sent7d: sql`${schema.autoRules.sent7d} + ${ids.length}` }).where(eq(schema.autoRules.key, key));
    if (rule.channels.includes('sms')) {
      // SMS goes out in the background so the API answers fast.
      void Promise.all([smsPhones(ids), brandName()]).then(([phones, brand]) => sendBulkTextSms(phones, `${brand}: ${body}`)).catch((err) => logger.warn({ err, key }, 'rule SMS failed'));
    }
  } catch (err) {
    logger.warn({ err, key }, 'notifyRule failed');
  }
  return ids.length;
}
