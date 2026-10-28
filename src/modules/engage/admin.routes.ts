import { Router } from 'express';
import { and, asc, count, desc, eq, ilike, lt, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { getSetting, setSetting } from '../../lib/settings';
import { sendBulkTextSms } from '../../lib/sms';
import { emitToUser } from '../../realtime';
import { logger } from '../../lib/logger';
import { requireAdmin, requirePerm } from '../../middleware/auth';
import { brandName } from '../../lib/brand';

const { campaigns, autoRules, users, notifications } = schema;

export const engage = Router();
engage.use(requireAdmin, requirePerm('engage'));

/* ============================ Campaigns ============================ */

const segment = z.object({
  plan: z.string().default('all'),          // all | free | paid | <planId>
  craft: z.string().default('all'),
  city: z.string().default('all'),
  inactiveDays: z.coerce.number().int().min(0).max(365).default(0), // 0 = everyone; 30 = not seen for 30+ days
});
type Segment = z.infer<typeof segment>;

function segmentWhere(s: Segment) {
  const w: SQL[] = [eq(users.status, 'ACTIVE')];
  if (s.plan === 'free') w.push(eq(users.planId, 'free'));
  else if (s.plan === 'paid') w.push(ne(users.planId, 'free'));
  else if (s.plan !== 'all') w.push(eq(users.planId, s.plan));
  if (s.craft !== 'all') w.push(sql`${s.craft} = ANY(${users.crafts})`);
  if (s.city !== 'all') w.push(ilike(users.city, s.city));
  if (s.inactiveDays > 0) w.push(lt(users.lastActiveAt, new Date(Date.now() - s.inactiveDays * 86_400_000)));
  return and(...w);
}

const audienceSize = async (s: Segment) => (await db.select({ n: count() }).from(users).where(segmentWhere(s)))[0].n;

const campaignInput = z.object({
  title: z.string().trim().min(2).max(80), message: z.string().trim().min(5).max(300),
  channels: z.array(z.enum(['push', 'sms'])).min(1).default(['push']), segment, link: z.string().max(300).nullable().optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
});

engage.get('/campaigns', ah(async (_req, res) => {
  await sendDueCampaigns();
  const rows = await db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).limit(200);
  // "Opened" = members who opened the in-app notification.
  const opened = rows.some((r) => r.status === 'sent') ? await db.select({ type: notifications.type, n: count() }).from(notifications)
    .where(and(sql`${notifications.type} LIKE 'campaign:%'`, sql`${notifications.readAt} IS NOT NULL`)).groupBy(notifications.type) : [];
  const om = new Map(opened.map((o) => [o.type, o.n]));
  res.json({ items: rows.map((r) => ({ ...r, opened: om.get(`campaign:${r.id}`) ?? 0 })) });
}));

/** How many members a segment reaches (before sending). */
engage.post('/campaigns/audience', ah(async (req, res) => {
  const s = parse(segment, req.body);
  const n = await audienceSize(s);
  const [sms] = await db.select({ n: count() }).from(users).where(and(segmentWhere(s), sql`coalesce((${users.prefs}->>'sms')::boolean, true)`));
  res.json({ audience: n, smsReachable: sms.n });
}));

/** Create. send=true sends now; scheduledAt sets a time; otherwise saved as draft. */
engage.post('/campaigns', ah(async (req, res) => {
  const b = parse(campaignInput.extend({ send: z.boolean().default(false) }), req.body);
  if (b.scheduledAt && b.scheduledAt <= new Date() && !b.send) throw badRequest('Pick a future time, or send now');
  const [c] = await db.insert(campaigns).values({ title: b.title, message: b.message, channels: b.channels, segment: b.segment, link: b.link ?? null, scheduledAt: b.scheduledAt ?? null, status: b.send ? 'sending' : b.scheduledAt ? 'scheduled' : 'draft', audience: await audienceSize(b.segment), createdBy: req.admin!.name }).returning();
  await audit(req, 'engage', b.send ? 'Sent campaign' : b.scheduledAt ? 'Scheduled campaign' : 'Saved campaign draft', b.title);
  const out = b.send ? await sendCampaign(c.id) : c;
  res.status(201).json({ campaign: out });
}));

engage.patch('/campaigns/:id', ah(async (req, res) => {
  const c = await db.query.campaigns.findFirst({ where: eq(campaigns.id, req.params.id) });
  if (!c) throw notFound('Campaign');
  if (!['draft', 'scheduled'].includes(c.status)) throw badRequest('Sent campaigns can’t be changed');
  const b = parse(campaignInput.partial(), req.body);
  const patch: Partial<typeof campaigns.$inferInsert> = { ...b, link: b.link ?? c.link };
  if (b.segment) patch.audience = await audienceSize(b.segment);
  if (b.scheduledAt !== undefined) patch.status = b.scheduledAt ? 'scheduled' : 'draft';
  const [row] = await db.update(campaigns).set(patch).where(eq(campaigns.id, c.id)).returning();
  res.json({ campaign: row });
}));

engage.post('/campaigns/:id/send', ah(async (req, res) => {
  const c = await db.query.campaigns.findFirst({ where: eq(campaigns.id, req.params.id) });
  if (!c) throw notFound('Campaign');
  if (!['draft', 'scheduled'].includes(c.status)) throw badRequest('Already sent');
  await db.update(campaigns).set({ status: 'sending' }).where(eq(campaigns.id, c.id));
  await audit(req, 'engage', 'Sent campaign', c.title);
  res.json({ campaign: await sendCampaign(c.id) });
}));

engage.delete('/campaigns/:id', ah(async (req, res) => {
  const [c] = await db.delete(campaigns).where(and(eq(campaigns.id, req.params.id), sql`${campaigns.status} IN ('draft','scheduled')`)).returning();
  if (!c) throw badRequest('Only drafts and scheduled campaigns can be deleted');
  await audit(req, 'engage', 'Deleted campaign', c.title);
  res.json({ ok: true });
}));

/** Delivers a campaign: in-app to everyone in the segment, SMS to those who allow it. */
export async function sendCampaign(id: string) {
  const c = (await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) }))!;
  const s = c.segment as Segment;
  let delivered = 0;
  const smsPhones: string[] = [];
  let lastId = '';
  for (;;) {
    const batch = await db.select({ id: users.id, phone: users.phone, prefs: users.prefs }).from(users).where(and(segmentWhere(s), sql`${users.id} > ${lastId}`)).orderBy(asc(users.id)).limit(1000);
    if (!batch.length) break;
    lastId = batch[batch.length - 1].id;
    if (c.channels.includes('push')) {
      const rows = await db.insert(notifications).values(batch.map((u) => ({ userId: u.id, type: `campaign:${c.id}`, title: c.title, body: c.message, link: c.link }))).returning();
      rows.forEach((n) => emitToUser(n.userId, 'notification', n));
    }
    if (c.channels.includes('sms')) smsPhones.push(...batch.filter((u) => (u.prefs as Record<string, boolean>).sms !== false && (u.prefs as Record<string, boolean>).offers !== false).map((u) => u.phone));
    delivered += batch.length;
  }
  const [row] = await db.update(campaigns).set({ status: 'sent', sentAt: new Date(), delivered, audience: delivered }).where(eq(campaigns.id, c.id)).returning();
  if (smsPhones.length) void sendBulkTextSms(smsPhones, `${await brandName()}: ${c.message}`).catch((err) => logger.warn({ err }, 'campaign SMS failed'));
  return row;
}

/** Scheduled campaigns whose time has come. Called by the jobs runner and when admins open the list. */
export async function sendDueCampaigns() {
  const due = await db.update(campaigns).set({ status: 'sending' }).where(and(eq(campaigns.status, 'scheduled'), lt(campaigns.scheduledAt, new Date()))).returning({ id: campaigns.id });
  for (const d of due) await sendCampaign(d.id);
  return due.length;
}

/* ============================ Auto messages ============================ */

engage.get('/rules', ah(async (_req, res) => {
  res.json({ items: await db.select().from(autoRules).orderBy(asc(autoRules.group), asc(autoRules.name)) });
}));

engage.patch('/rules/:key', ah(async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean(), template: z.string().trim().min(5).max(300), channels: z.array(z.enum(['push', 'sms'])).min(1) }).partial(), req.body);
  const [row] = await db.update(autoRules).set(b).where(eq(autoRules.key, req.params.key)).returning();
  if (!row) throw notFound('Rule');
  await audit(req, 'engage', `Auto message “${row.name}”: ${Object.keys(b).join(', ')}`, row.key);
  res.json({ rule: row });
}));

/* ============================ Home page ============================ */

const banner = z.object({
  id: z.string().max(40), title: z.string().max(80), subtitle: z.string().max(160).default(''), image: z.string().max(500).default(''),
  ctaLabel: z.string().max(30).default(''), ctaLink: z.string().max(300).default(''), audience: z.enum(['all', 'free', 'paid', 'visitors']).default('all'),
  startsAt: z.string().nullable().optional(), endsAt: z.string().nullable().optional(), active: z.boolean().default(true), tone: z.string().max(20).optional(),
});
const homeInput = z.object({
  hero: z.object({ title: z.string().max(80), subtitle: z.string().max(200), ctaLabel: z.string().max(30), joinLabel: z.string().max(40), trustLine: z.string().max(140), image: z.string().max(500) }).partial(),
  announcement: z.object({ enabled: z.boolean(), text: z.string().max(140), link: z.string().max(300), tone: z.string().max(20) }).partial(),
  banners: z.array(banner).max(10),
  sections: z.array(z.object({ id: z.string(), label: z.string().optional(), visible: z.boolean() }).passthrough()).max(20),
  featuredCastings: z.array(z.string()).max(12),
  featuredTalent: z.array(z.string()).max(24),
  seo: z.object({ title: z.string().max(70), description: z.string().max(170) }).partial(),
}).partial();

engage.get('/home', ah(async (_req, res) => { res.json(await getSetting('home', {})); }));

engage.put('/home', ah(async (req, res) => {
  const b = parse(homeInput, req.body);
  const cur = await getSetting<Record<string, unknown>>('home', {});
  const next: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(b)) next[k] = Array.isArray(v) || typeof v !== 'object' ? v : { ...(cur[k] as object ?? {}), ...v };
  await setSetting('home', next, req.admin!.name);
  await audit(req, 'engage', `Home page: ${Object.keys(b).join(', ')}`, 'home');
  res.json(next);
}));
