import { and, eq, gt, isNotNull, lt, lte, ne, notExists, or, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { logger } from './lib/logger';
import { notifyRule } from './lib/notify';
import { publishDue } from './modules/castings/service';
import { sendDueCampaigns } from './modules/engage/admin.routes';
import { anonymizeUser } from './modules/members/review.routes';

const { castings, users, notifications, otpCodes, refreshTokens, dataRequests, autoRules } = schema;
const DAY = 86_400_000;

/**
 * Background jobs. Run every 10 minutes by the server (and on demand from Admin → System).
 * Each job is safe to run again: it only touches rows that still need it.
 */
export async function runJobs() {
  const out: Record<string, number | string> = {};
  const step = async (name: string, fn: () => Promise<number>) => {
    try { out[name] = await fn(); } catch (err) { out[name] = 'error'; logger.error({ err, job: name }, 'job failed'); }
  };

  await step('castingsPublished', async () => { await publishDue(); return 0; });

  // Castings past their last date stop taking applications.
  await step('castingsClosed', async () => (await db.update(castings).set({ status: 'CLOSED' }).where(and(eq(castings.status, 'LIVE'), lt(castings.deadline, new Date()))).returning({ id: castings.id })).length);

  await step('campaignsSent', sendDueCampaigns);

  // Paid plans ending within 3 days → one reminder (not sent again within 5 days).
  await step('planReminders', async () => {
    const soon = await db.select({ id: users.id, planId: users.planId, until: users.planUntil }).from(users).where(and(
      ne(users.planId, 'free'), eq(users.status, 'ACTIVE'), isNotNull(users.planUntil), gt(users.planUntil, new Date()), lte(users.planUntil, new Date(Date.now() + 3 * DAY)),
      notExists(db.select().from(notifications).where(and(eq(notifications.userId, users.id), eq(notifications.type, 'plan_expiring'), gt(notifications.createdAt, new Date(Date.now() - 5 * DAY))))),
    )).limit(5000);
    for (const u of soon) {
      await notifyRule('plan_expiring', u.id, { plan: u.planId === 'pro' ? 'Pro' : u.planId, date: u.until!.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) }, '/my-plan');
    }
    return soon.length;
  });

  // Ended paid plans go back to Free (also happens on the member's next request).
  await step('plansExpired', async () => (await db.update(users).set({ planId: 'free', planCycle: null }).where(and(ne(users.planId, 'free'), isNotNull(users.planUntil), lt(users.planUntil, new Date()))).returning({ id: users.id })).length);

  // Suspensions that have ended.
  await step('suspensionsLifted', async () => (await db.update(users).set({ status: 'ACTIVE', suspendedUntil: null }).where(and(eq(users.status, 'SUSPENDED'), isNotNull(users.suspendedUntil), lt(users.suspendedUntil, new Date()))).returning({ id: users.id })).length);

  // Accounts that asked to be deleted 30+ days ago and didn't log back in.
  await step('accountsDeleted', async () => {
    const due = await db.select({ id: users.id }).from(users).where(and(isNotNull(users.deletionRequestedAt), lt(users.deletionRequestedAt, new Date(Date.now() - 30 * DAY)), ne(users.status, 'DELETED'))).limit(200);
    for (const u of due) {
      await anonymizeUser(u.id);
      await db.update(dataRequests).set({ status: 'done', handledBy: 'Automatic (30 days)', handledAt: new Date() }).where(and(eq(dataRequests.userId, u.id), eq(dataRequests.type, 'delete'), eq(dataRequests.status, 'pending')));
    }
    return due.length;
  });

  // Housekeeping.
  await step('otpCleaned', async () => (await db.delete(otpCodes).where(lt(otpCodes.createdAt, new Date(Date.now() - 2 * DAY))).returning({ id: otpCodes.id })).length);
  await step('sessionsCleaned', async () => (await db.delete(refreshTokens).where(or(lt(refreshTokens.expiresAt, new Date()), lt(refreshTokens.revokedAt, new Date(Date.now() - 7 * DAY)))).returning({ id: refreshTokens.id })).length);
  await step('ruleCounters', async () => {
    // "Sent in last 7 days" on Auto messages, recounted from notifications.
    await db.execute(sql`UPDATE ${autoRules} r SET sent_7d = coalesce((SELECT count(*) FROM ${notifications} n WHERE n.type = r.key AND n.created_at > now() - interval '7 days'), 0)`);
    return 0;
  });
  return out;
}

let timer: NodeJS.Timeout | null = null;
export function startJobs(everyMs = 10 * 60_000) {
  if (timer) return;
  const tick = () => runJobs().then((r) => logger.info({ jobs: r }, 'jobs ran')).catch((err) => logger.error({ err }, 'jobs failed'));
  setTimeout(tick, 15_000);
  timer = setInterval(tick, everyMs);
}
export const stopJobs = () => { if (timer) clearInterval(timer); timer = null; };
