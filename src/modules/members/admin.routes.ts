import { Router } from 'express';
import { and, asc, count, desc, eq, gte, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { db, schema } from '../../db';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { adminUser, publicUser } from '../../lib/serialize';
import { audit } from '../../lib/audit';
import { notify } from '../../lib/notify';
import { removeFile, signDocs } from '../../lib/storage';
import { getSetting, setSetting } from '../../lib/settings';
import { requireAdmin, requirePerm } from '../../middleware/auth';
import { revokeAllFor } from '../auth/tokens';
import { profileSchema } from './validators';
import { anonymizeUser } from './review.routes';
import { brandName } from '../../lib/brand';

const { users, media, follows, profileViews, applications, payments } = schema;
const router = Router();
router.use(requireAdmin, requirePerm('users'));

const listSchema = z.object({
  q: z.string().trim().max(80).optional(),
  plan: z.enum(['free', 'paid']).or(z.string().max(30)).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED', 'BLOCKED']).optional(),
  gender: z.enum(['Male', 'Female', 'Other']).optional(),
  /** Paid members whose plan ends within 7 days, or has already ended. */
  planState: z.enum(['expiring', 'expired']).optional(),
  language: z.string().max(40).optional(),
  ageMin: z.coerce.number().int().min(0).max(100).optional(),
  ageMax: z.coerce.number().int().min(0).max(100).optional(),
  heightMin: z.coerce.number().int().min(0).max(260).optional(),
  ids: z.string().max(10_000).optional(),
  muted: z.enum(['true']).optional(),
  verified: z.enum(['true', 'false']).optional(),
  minor: z.enum(['true', 'false']).optional(),
  city: z.string().max(60).optional(),
  craft: z.string().max(40).optional(),
  joinedFrom: z.coerce.date().optional(),
  sort: z.enum(['new', 'old', 'active', 'name', 'views', 'expiry', 'relevant']).default('new'),
});

/** Member list with filters. Phones are masked; reveal one with GET /:id/phone (audited). */
router.get('/', ah(async (req, res) => {
  const f = parse(listSchema, req.query);
  const { page, limit, skip } = paging(req.query, 100);
  const w: SQL[] = [];
  if (f.q) {
    const digits = f.q.replace(/\D/g, '');
    w.push(or(ilike(users.name, `%${f.q}%`), ilike(users.code, `%${f.q}%`), ilike(users.email, `%${f.q}%`), ...(digits.length >= 4 ? [ilike(users.phone, `%${digits}%`)] : []))!);
  }
  if (f.plan === 'free') w.push(eq(users.planId, 'free'));
  else if (f.plan === 'paid') w.push(ne(users.planId, 'free'));
  else if (f.plan) w.push(eq(users.planId, f.plan));
  if (f.status === 'BLOCKED') w.push(inArray(users.status, ['SUSPENDED', 'BANNED']));
  else if (f.status) w.push(eq(users.status, f.status)); else w.push(ne(users.status, 'DELETED'));
  if (f.gender) w.push(eq(users.gender, f.gender));
  if (f.planState === 'expiring') w.push(sql`${users.planId} <> 'free' AND ${users.planUntil} BETWEEN now() AND now() + interval '7 days'`);
  if (f.planState === 'expired') w.push(sql`${users.planId} <> 'free' AND ${users.planUntil} < now()`);
  if (f.verified) w.push(eq(users.verified, f.verified === 'true'));
  if (f.minor) w.push(eq(users.isMinor, f.minor === 'true'));
  if (f.city) w.push(ilike(users.city, f.city));
  if (f.craft) w.push(sql`${f.craft} = ANY(${users.crafts})`);
  if (f.joinedFrom) w.push(gte(users.createdAt, f.joinedFrom));
  if (f.language) w.push(sql`${f.language} = ANY(${users.languages})`);
  if (f.ageMin !== undefined) w.push(sql`${users.dob} <= now() - make_interval(years => ${f.ageMin})`);
  if (f.ageMax !== undefined) w.push(sql`${users.dob} > now() - make_interval(years => ${f.ageMax + 1})`);
  if (f.heightMin) w.push(gte(users.heightCm, f.heightMin));
  if (f.muted) w.push(sql`${users.chatMutedUntil} > now()`);
  if (f.ids) w.push(inArray(users.id, f.ids.split(',').filter(Boolean).slice(0, 500)));
  const where = and(...w);
  const proFirst = sql`CASE WHEN ${users.planId} <> 'free' AND (${users.planUntil} IS NULL OR ${users.planUntil} > now()) THEN 0 ELSE 1 END`;
  const order = { relevant: sql`${proFirst}, ${users.verified} DESC, ${users.profileViews} DESC`, new: desc(users.createdAt), old: asc(users.createdAt), active: desc(users.lastActiveAt), name: asc(users.name), views: desc(users.profileViews), expiry: sql`${users.planUntil} ASC NULLS LAST` }[f.sort];
  const [{ n }] = await db.select({ n: count() }).from(users).where(where);
  const rows = await db.select().from(users).where(where).orderBy(order).limit(limit).offset(skip);
  res.json(pageResult(rows.map(adminUser), n, page, limit));
}));

router.get('/stats', ah(async (_req, res) => {
  const [rev] = await db.select({ n: sql<number>`coalesce(sum(${payments.amount}), 0)`.mapWith(Number) }).from(payments).where(inArray(payments.status, ['SUCCESS', 'REFUNDED', 'PARTIAL_REFUND']));
  const [r] = await db.select({
    total: sql<number>`count(*) FILTER (WHERE ${users.status} <> 'DELETED')`.mapWith(Number),
    paid: sql<number>`count(*) FILTER (WHERE ${users.planId} <> 'free' AND ${users.status} <> 'DELETED')`.mapWith(Number),
    verified: sql<number>`count(*) FILTER (WHERE ${users.verified})`.mapWith(Number),
    suspended: sql<number>`count(*) FILTER (WHERE ${users.status} = 'SUSPENDED')`.mapWith(Number),
    banned: sql<number>`count(*) FILTER (WHERE ${users.status} = 'BANNED')`.mapWith(Number),
    minors: sql<number>`count(*) FILTER (WHERE ${users.isMinor} AND ${users.status} <> 'DELETED')`.mapWith(Number),
    joined7d: sql<number>`count(*) FILTER (WHERE ${users.createdAt} > now() - interval '7 days')`.mapWith(Number),
    active7d: sql<number>`count(*) FILTER (WHERE ${users.lastActiveAt} > now() - interval '7 days')`.mapWith(Number),
    expiring: sql<number>`count(*) FILTER (WHERE ${users.planId} <> 'free' AND ${users.planUntil} BETWEEN now() AND now() + interval '7 days')`.mapWith(Number),
    expired: sql<number>`count(*) FILTER (WHERE ${users.planId} <> 'free' AND ${users.planUntil} < now() AND ${users.status} <> 'DELETED')`.mapWith(Number),
  }).from(users);
  res.json({ ...r, revenue: rev.n });
}));

/* ---------------------------- Duplicates ---------------------------- */

type DupGroup = { key: string; reason: string; users: ReturnType<typeof adminUser>[] };

/** Accounts that look like the same person: same name, same email, or same guardian phone. */
router.get('/duplicates', ah(async (_req, res) => {
  const dismissed = new Set((await getSetting<{ key: string }[]>('dupDismissed', [])).map((d) => d.key));
  const active = ne(users.status, 'DELETED');
  const byName = await db.select({ k: sql<string>`lower(trim(${users.name}))` }).from(users).where(and(active, ne(users.name, ''))).groupBy(sql`lower(trim(${users.name}))`).having(sql`count(*) > 1`).limit(100);
  const byEmail = await db.select({ k: sql<string>`lower(${users.email})` }).from(users).where(and(active, sql`${users.email} IS NOT NULL AND ${users.email} <> ''`)).groupBy(sql`lower(${users.email})`).having(sql`count(*) > 1`).limit(100);
  const byGuardian = await db.select({ k: users.guardianPhone }).from(users).where(and(active, sql`${users.guardianPhone} IS NOT NULL`)).groupBy(users.guardianPhone).having(sql`count(*) > 1`).limit(100);

  const groups: DupGroup[] = [];
  const add = async (reason: string, prefix: string, keys: (string | null)[], col: SQL) => {
    for (const k of keys) {
      if (!k) continue;
      const key = `${prefix}:${k}`;
      if (dismissed.has(key)) continue;
      const rows = await db.select().from(users).where(and(active, sql`${col} = ${k}`)).orderBy(asc(users.createdAt));
      groups.push({ key, reason, users: rows.map(adminUser) });
    }
  };
  await add('Same name', 'name', byName.map((r) => r.k), sql`lower(trim(${users.name}))`);
  await add('Same email', 'email', byEmail.map((r) => r.k), sql`lower(${users.email})`);
  await add('Same guardian phone', 'guardian', byGuardian.map((r) => r.k), sql`${users.guardianPhone}`);
  res.json({ items: groups });
}));

router.post('/duplicates/dismiss', ah(async (req, res) => {
  const { key } = parse(z.object({ key: z.string().min(3).max(200) }), req.body);
  const list = await getSetting<{ key: string; at: string }[]>('dupDismissed', []);
  if (!list.some((d) => d.key === key)) await setSetting('dupDismissed', [...list, { key, at: new Date().toISOString() }], req.admin!.name);
  await audit(req, 'users', 'Marked duplicate as not a duplicate', key);
  res.json({ ok: true });
}));

/* ---------------------------- Saved talent lists (Talent Search) ---------------------------- */

type TalentList = { id: string; name: string; userIds: string[]; createdBy: string; createdAt: string };
const LISTS = 'talentLists';

router.get('/lists', ah(async (_req, res) => {
  res.json({ items: await getSetting<TalentList[]>(LISTS, []) });
}));

router.post('/lists', ah(async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(80), userIds: z.array(z.string()).max(500).default([]) }), req.body);
  const lists = await getSetting<TalentList[]>(LISTS, []);
  const item: TalentList = { id: randomUUID(), name: body.name, userIds: [...new Set(body.userIds)], createdBy: req.admin!.name, createdAt: new Date().toISOString() };
  await setSetting(LISTS, [...lists, item], req.admin!.name);
  await audit(req, 'users', `Created talent list (${item.userIds.length})`, item.name);
  res.status(201).json({ item });
}));

router.patch('/lists/:listId', ah(async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), add: z.array(z.string()).max(500).optional(), remove: z.array(z.string()).max(500).optional() }), req.body);
  const lists = await getSetting<TalentList[]>(LISTS, []);
  const cur = lists.find((l) => l.id === req.params.listId);
  if (!cur) throw notFound('List');
  const next: TalentList = { ...cur, name: body.name ?? cur.name, userIds: [...new Set([...cur.userIds, ...(body.add ?? [])])].filter((x) => !(body.remove ?? []).includes(x)).slice(0, 2000) };
  await setSetting(LISTS, lists.map((l) => (l.id === cur.id ? next : l)), req.admin!.name);
  res.json({ item: next });
}));

router.delete('/lists/:listId', ah(async (req, res) => {
  const lists = await getSetting<TalentList[]>(LISTS, []);
  const cur = lists.find((l) => l.id === req.params.listId);
  if (!cur) throw notFound('List');
  await setSetting(LISTS, lists.filter((l) => l.id !== cur.id), req.admin!.name);
  await audit(req, 'users', 'Deleted talent list', cur.name);
  res.json({ ok: true });
}));

/* ---------------------------- One member ---------------------------- */

async function load(id: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!u) throw notFound('Member');
  return u;
}

router.get('/:id', ah(async (req, res) => {
  const u = await load(req.params.id);
  const [gallery, [fs], [fg], [apps], pays, verif, referrer] = await Promise.all([
    db.select().from(media).where(eq(media.userId, u.id)).orderBy(asc(media.order)),
    db.select({ n: count() }).from(follows).where(eq(follows.followingId, u.id)),
    db.select({ n: count() }).from(follows).where(eq(follows.followerId, u.id)),
    db.select({ n: count() }).from(applications).where(eq(applications.userId, u.id)),
    db.select().from(payments).where(eq(payments.userId, u.id)).orderBy(desc(payments.createdAt)).limit(20),
    db.select().from(schema.verificationRequests).where(eq(schema.verificationRequests.userId, u.id)).orderBy(desc(schema.verificationRequests.submittedAt)).limit(5),
    u.referredById ? db.query.users.findFirst({ where: eq(users.id, u.referredById), columns: { id: true, name: true, code: true } }) : Promise.resolve(undefined),
  ]);
  const [recentApps, reportsAgainst, activity] = await Promise.all([
    db.select({ id: applications.id, status: applications.status, appliedAt: applications.createdAt, castingId: schema.castings.id, castingCode: schema.castings.code, castingTitle: schema.castings.title, posterUrl: schema.castings.posterUrl, roleName: schema.castingRoles.name })
      .from(applications).innerJoin(schema.castings, eq(schema.castings.id, applications.castingId)).innerJoin(schema.castingRoles, eq(schema.castingRoles.id, applications.roleId))
      .where(eq(applications.userId, u.id)).orderBy(desc(applications.createdAt)).limit(50),
    db.select().from(schema.reports).where(eq(schema.reports.reportedUserId, u.id)).orderBy(desc(schema.reports.createdAt)).limit(30),
    db.select().from(schema.auditLogs).where(ilike(schema.auditLogs.target, `%${u.code}%`)).orderBy(desc(schema.auditLogs.createdAt)).limit(30),
  ]);
  res.json({ user: adminUser(u), media: gallery, followers: fs.n, following: fg.n, applications: apps.n, payments: pays, verification: verif.map(signDocs), referredBy: referrer ?? null, recentApplications: recentApps, reports: reportsAgainst, activity });
}));

/** Shows the full phone number. Every reveal is written to the audit log. */
router.get('/:id/phone', ah(async (req, res) => {
  const u = await load(req.params.id);
  await audit(req, 'users', 'Viewed phone number', `${u.code} ${u.name}`);
  res.json({ phone: u.phone, guardianPhone: u.guardianPhone });
}));

router.patch('/:id', ah(async (req, res) => {
  const u = await load(req.params.id);
  const body = parse(profileSchema.omit({ guardianConsent: true }), req.body);
  const patch: Record<string, unknown> = { ...body };
  for (const k of ['email', 'instagram', 'youtube'] as const) if (body[k] === '') patch[k] = null;
  const [user] = await db.update(users).set(patch).where(eq(users.id, u.id)).returning();
  await audit(req, 'users', `Edited profile (${Object.keys(body).join(', ')})`, `${u.code} ${u.name}`);
  res.json({ user: adminUser(user) });
}));

const reason = z.object({ reason: z.string().trim().min(3, 'Add a short reason').max(500) });

router.post('/:id/warn', ah(async (req, res) => {
  const u = await load(req.params.id);
  const { reason: r } = parse(reason, req.body);
  const [user] = await db.update(users).set({ warnings: sql`${users.warnings} + 1` }).where(eq(users.id, u.id)).returning();
  await notify(u.id, 'warning', `A warning from ${await brandName()}`, r);
  await audit(req, 'users', `Warned member: ${r}`, `${u.code} ${u.name}`);
  res.json({ user: adminUser(user) });
}));

router.post('/:id/suspend', ah(async (req, res) => {
  const u = await load(req.params.id);
  const body = parse(reason.extend({ days: z.coerce.number().int().min(1).max(365) }), req.body);
  const until = new Date(Date.now() + body.days * 86_400_000);
  const [user] = await db.update(users).set({ status: 'SUSPENDED', suspendedUntil: until }).where(eq(users.id, u.id)).returning();
  await revokeAllFor('member', u.id);
  await audit(req, 'users', `Suspended for ${body.days} days: ${body.reason}`, `${u.code} ${u.name}`);
  res.json({ user: adminUser(user) });
}));

router.post('/:id/ban', ah(async (req, res) => {
  const u = await load(req.params.id);
  const { reason: r } = parse(reason, req.body);
  const [user] = await db.update(users).set({ status: 'BANNED', suspendedUntil: null }).where(eq(users.id, u.id)).returning();
  await revokeAllFor('member', u.id);
  await audit(req, 'users', `Banned: ${r}`, `${u.code} ${u.name}`);
  res.json({ user: adminUser(user) });
}));

router.post('/:id/reactivate', ah(async (req, res) => {
  const u = await load(req.params.id);
  if (u.status === 'DELETED') throw badRequest('Deleted accounts can’t be brought back');
  const [user] = await db.update(users).set({ status: 'ACTIVE', suspendedUntil: null }).where(eq(users.id, u.id)).returning();
  await audit(req, 'users', 'Reactivated account', `${u.code} ${u.name}`);
  res.json({ user: adminUser(user) });
}));

/** Stops the member from sending chat messages for some hours. hours: 0 = unmute. */
router.post('/:id/mute', ah(async (req, res) => {
  const u = await load(req.params.id);
  const { hours } = parse(z.object({ hours: z.coerce.number().int().min(0).max(24 * 90) }), req.body);
  const [user] = await db.update(users).set({ chatMutedUntil: hours ? new Date(Date.now() + hours * 3_600_000) : null }).where(eq(users.id, u.id)).returning();
  await audit(req, 'users', hours ? `Muted chat for ${hours} hours` : 'Unmuted chat', `${u.code} ${u.name}`);
  res.json({ user: adminUser(user) });
}));

router.post('/:id/verified', ah(async (req, res) => {
  const u = await load(req.params.id);
  const { verified } = parse(z.object({ verified: z.boolean() }), req.body);
  const [user] = await db.update(users).set({ verified }).where(eq(users.id, u.id)).returning();
  await audit(req, 'users', verified ? 'Marked verified' : 'Removed verified badge', `${u.code} ${u.name}`);
  res.json({ user: adminUser(user) });
}));

/** Give a member a plan for free (complimentary), extend it, or move them back to Free. */
router.post('/:id/plan', ah(async (req, res) => {
  const u = await load(req.params.id);
  const body = parse(z.object({ planId: z.string().min(1).max(30), days: z.coerce.number().int().min(1).max(3650).optional(), note: z.string().max(300).default('') }), req.body);
  const plan = await db.query.plans.findFirst({ where: eq(schema.plans.id, body.planId) });
  if (!plan) throw notFound('Plan');
  let patch: Partial<typeof users.$inferInsert>;
  if (plan.isFree) patch = { planId: plan.id, planCycle: null, planUntil: null };
  else {
    if (!body.days) throw badRequest('How many days of Pro? (days)');
    const from = u.planId === plan.id && u.planUntil && u.planUntil > new Date() ? u.planUntil : new Date();
    patch = { planId: plan.id, planUntil: new Date(from.getTime() + body.days * 86_400_000) };
  }
  const [user] = await db.update(users).set(patch).where(eq(users.id, u.id)).returning();
  if (!plan.isFree) await notify(u.id, 'plan', `You got ${plan.name}!`, `The ${await brandName()} team added ${body.days} days of ${plan.name} to your account.`, '/my-plan');
  await audit(req, 'users', plan.isFree ? 'Moved to Free plan' : `Gave ${plan.name} for ${body.days} days${body.note ? `: ${body.note}` : ''}`, `${u.code} ${u.name}`);
  res.json({ user: adminUser(user) });
}));

router.delete('/:id/media/:mediaId', ah(async (req, res) => {
  const u = await load(req.params.id);
  const [item] = await db.delete(media).where(and(eq(media.id, req.params.mediaId), eq(media.userId, u.id))).returning();
  if (!item) throw notFound('Photo');
  await removeFile(item.url);
  await audit(req, 'users', `Removed ${item.type.toLowerCase()} from gallery`, `${u.code} ${u.name}`);
  res.json({ ok: true });
}));

router.delete('/:id/avatar', ah(async (req, res) => {
  const u = await load(req.params.id);
  await removeFile(u.avatarUrl);
  await db.update(users).set({ avatarUrl: null }).where(eq(users.id, u.id));
  await audit(req, 'users', 'Removed profile photo', `${u.code} ${u.name}`);
  res.json({ ok: true });
}));

/** Sends the member an in-app notification from the team. */
router.post('/:id/message', ah(async (req, res) => {
  const u = await load(req.params.id);
  const body = parse(z.object({ title: z.string().trim().max(100).optional(), message: z.string().trim().min(2).max(1000) }), req.body);
  await notify(u.id, 'admin', body.title || `Message from ${await brandName()}`, body.message);
  await audit(req, 'users', `Sent a message: ${body.message.slice(0, 80)}`, `${u.code} ${u.name}`);
  res.json({ ok: true });
}));

/** Deletes the account: personal details, photos and documents are removed; payment rows stay for GST records. */
router.delete('/:id', ah(async (req, res) => {
  const u = await load(req.params.id);
  if (u.status === 'DELETED') throw badRequest('Already deleted');
  await revokeAllFor('member', u.id);
  await anonymizeUser(u.id);
  await audit(req, 'users', 'Deleted account', `${u.code} ${u.name}`);
  res.json({ ok: true });
}));

/** Casting team "viewed" a profile — shows in the member's Who viewed me as "<platform> team". */
router.post('/:id/viewed', ah(async (req, res) => {
  const u = await load(req.params.id);
  await db.insert(profileViews).values({ viewedId: u.id, byAdmin: true });
  await db.update(users).set({ profileViews: sql`${users.profileViews} + 1` }).where(eq(users.id, u.id));
  res.json({ ok: true });
}));

/** Quick lookup for pickers (e.g. "add member to casting"). */
router.post('/lookup', ah(async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string()).max(200) }), req.body);
  const rows = ids.length ? await db.select().from(users).where(inArray(users.id, ids)) : [];
  res.json({ items: rows.map(publicUser) });
}));

export default router;
