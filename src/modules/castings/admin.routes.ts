import { Router } from 'express';
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db, schema } from '../../db';
import type { Casting } from '../../db/schema';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { notify, notifyRule } from '../../lib/notify';
import { nextCastingCode, randomCode } from '../../lib/codes';
import { env } from '../../config/env';
import { publicUser } from '../../lib/serialize';
import { requireAdmin, requirePerm } from '../../middleware/auth';
import { applicantCounts, assertSafeCasting, castingInput, publishDue, rolesFor, saveRoles } from './service';
import { pipelineRoutes } from './pipeline';
import { scheduleRoutes } from './schedule';
import { brandName } from '../../lib/brand';

const { castings, castingRoles, applications, users, auditionDays, auditionSlots, shortlistShares, shareItems, clients } = schema;

const router = Router();
router.use(requireAdmin, requirePerm('castings'));

const adminInput = castingInput.extend({
  visibility: z.enum(['ALL', 'PRO']).default('ALL'),
  proEarlyAccessHours: z.coerce.number().int().min(0).max(168).default(0),
  featured: z.boolean().default(false),
  urgent: z.boolean().default(false),
  sendAlert: z.boolean().default(true),
  clientId: z.string().nullable().optional(),
  publishAt: z.coerce.date().nullable().optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'LIVE']).default('DRAFT'),
});

async function load(id: string) {
  const c = await db.query.castings.findFirst({ where: eq(castings.id, id) });
  if (!c) throw notFound('Casting');
  return c;
}

async function full(c: Casting) {
  const [roles, counts] = await Promise.all([rolesFor([c.id]), applicantCounts([c.id])]);
  const poster = c.postedByUserId ? await db.query.users.findFirst({ where: eq(users.id, c.postedByUserId) }) : undefined;
  const client = c.clientId ? await db.query.clients.findFirst({ where: eq(clients.id, c.clientId) }) : undefined;
  return { ...c, roles: roles.get(c.id) ?? [], applicants: counts.get(c.id) ?? { total: 0 }, postedBy: poster ? { id: poster.id, code: poster.code, name: poster.name, verified: poster.verified, isPro: poster.planId !== 'free' } : null, client: client ?? null };
}

/** Members whose gender, age and city fit a role get the "New casting matches profile" alert. */
async function alertMatches(c: Casting) {
  if (!c.sendAlert) return 0;
  const roles = await db.select().from(castingRoles).where(eq(castingRoles.castingId, c.id));
  const city = c.location.split(/[,/]/)[0].trim();
  const ids = new Set<string>();
  for (const r of roles) {
    const w: SQL[] = [eq(users.status, 'ACTIVE'), sql`coalesce((${users.prefs}->>'castingAlerts')::boolean, true)`];
    if (r.gender !== 'Any') w.push(eq(users.gender, r.gender));
    w.push(sql`(${users.dob} IS NULL OR (${users.dob} <= now() - make_interval(years => ${r.ageMin}) AND ${users.dob} > now() - make_interval(years => ${r.ageMax + 1})))`);
    if (city && !/any|online|pan india/i.test(city) && c.mode === 'In person') w.push(or(ilike(users.city, city), isNull(users.city))!);
    if (c.postedByUserId) w.push(ne(users.id, c.postedByUserId));
    const rows = await db.select({ id: users.id }).from(users).where(and(...w)).limit(5000);
    rows.forEach((x) => ids.add(x.id));
  }
  const role = roles[0];
  return notifyRule('casting_match', [...ids], { role: role?.name ?? c.title, city: c.location, deadline: c.deadline.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }), casting: c.title }, `/auditions/${c.code}`);
}

async function goLive(c: Casting) {
  const [row] = await db.update(castings).set({ status: 'LIVE', publishedAt: c.publishedAt ?? new Date(), publishAt: null }).where(eq(castings.id, c.id)).returning();
  const alerted = c.publishedAt ? 0 : await alertMatches(row);
  return { row, alerted };
}

/* ---------------------------- List ---------------------------- */

router.get('/', ah(async (req, res) => {
  await publishDue();
  const f = parse(z.object({
    status: z.string().optional(), source: z.enum(['all', 'admin', 'member']).default('all'),
    q: z.string().trim().max(80).optional(), projectType: z.string().optional(), city: z.string().optional(), clientId: z.string().optional(),
    visibility: z.enum(['ALL', 'PRO']).optional(),
    sort: z.enum(['new', 'deadline', 'views', 'applicants']).default('new'),
  }), req.query);
  const { page, limit, skip } = paging(req.query, 100);
  const w: SQL[] = [];
  if (f.status && f.status !== 'all') w.push(inArray(castings.status, f.status.toUpperCase().split(',') as Casting['status'][]));
  if (f.source === 'admin') w.push(isNull(castings.postedByUserId));
  if (f.source === 'member') w.push(isNotNull(castings.postedByUserId));
  if (f.q) w.push(or(ilike(castings.title, `%${f.q}%`), ilike(castings.code, `%${f.q}%`), ilike(castings.production, `%${f.q}%`))!);
  if (f.projectType) w.push(eq(castings.projectType, f.projectType));
  if (f.city) w.push(ilike(castings.location, `%${f.city}%`));
  if (f.clientId) w.push(eq(castings.clientId, f.clientId));
  if (f.visibility) w.push(eq(castings.visibility, f.visibility));
  const where = w.length ? and(...w) : undefined;
  const apps = sql`(SELECT count(*) FROM ${applications} WHERE ${applications.castingId} = ${castings.id})`;
  const order = { new: desc(castings.createdAt), deadline: asc(castings.deadline), views: desc(castings.views), applicants: desc(apps) }[f.sort];
  const [{ n }] = await db.select({ n: count() }).from(castings).where(where);
  const rows = await db.select().from(castings).where(where).orderBy(order).limit(limit).offset(skip);
  const ids = rows.map((r) => r.id);
  const [roles, counts] = await Promise.all([rolesFor(ids), applicantCounts(ids)]);
  const posters = await db.select({ id: users.id, name: users.name, code: users.code }).from(users).where(inArray(users.id, rows.map((r) => r.postedByUserId).filter((x): x is string => !!x).concat('-')));
  const pm = new Map(posters.map((p) => [p.id, p]));
  const [tabs] = await db.select({
    pending: sql<number>`count(*) FILTER (WHERE ${castings.status} = 'PENDING')`.mapWith(Number),
    live: sql<number>`count(*) FILTER (WHERE ${castings.status} = 'LIVE')`.mapWith(Number),
    draft: sql<number>`count(*) FILTER (WHERE ${castings.status} = 'DRAFT')`.mapWith(Number),
    scheduled: sql<number>`count(*) FILTER (WHERE ${castings.status} = 'SCHEDULED')`.mapWith(Number),
    closed: sql<number>`count(*) FILTER (WHERE ${castings.status} = 'CLOSED')`.mapWith(Number),
    archived: sql<number>`count(*) FILTER (WHERE ${castings.status} = 'ARCHIVED')`.mapWith(Number),
    changes: sql<number>`count(*) FILTER (WHERE ${castings.status} IN ('CHANGES','REJECTED'))`.mapWith(Number),
    all: sql<number>`count(*)`.mapWith(Number),
    closingSoon: sql<number>`count(*) FILTER (WHERE ${castings.status} = 'LIVE' AND ${castings.deadline} < now() + interval '3 days')`.mapWith(Number),
  }).from(castings);
  res.json({ tabs, ...pageResult(rows.map((c) => ({ ...c, roles: roles.get(c.id) ?? [], applicants: counts.get(c.id) ?? { total: 0 }, postedBy: c.postedByUserId ? pm.get(c.postedByUserId) ?? null : null })), n, page, limit) });
}));

/** All audition days across castings (Audition Schedule page). ?from=YYYY-MM-DD (default: 30 days ago) */
router.get('/schedule/days', ah(async (req, res) => {
  const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select({ d: auditionDays, c: { id: castings.id, code: castings.code, title: castings.title, venue: castings.venue } }).from(auditionDays)
    .innerJoin(castings, eq(castings.id, auditionDays.castingId)).where(sql`${auditionDays.date} >= ${from}`).orderBy(asc(auditionDays.date), asc(auditionDays.start));
  const counts = rows.length ? await db.select({ dayId: auditionSlots.dayId, total: count(), booked: sql<number>`count(${auditionSlots.applicationId})`.mapWith(Number) })
    .from(auditionSlots).where(inArray(auditionSlots.dayId, rows.map((r) => r.d.id))).groupBy(auditionSlots.dayId) : [];
  const cm = new Map(counts.map((c) => [c.dayId, c]));
  res.json({ items: rows.map(({ d, c }) => ({ ...d, casting: c, slots: cm.get(d.id)?.total ?? 0, booked: cm.get(d.id)?.booked ?? 0 })) });
}));

/** Every client shortlist link across castings (Client Shortlists page), with each talent's pick. */
router.get('/shares/all', ah(async (_req, res) => {
  const rows = await db.select({ s: shortlistShares, cl: clients, c: { id: castings.id, code: castings.code, title: castings.title } }).from(shortlistShares)
    .innerJoin(clients, eq(clients.id, shortlistShares.clientId)).innerJoin(castings, eq(castings.id, shortlistShares.castingId))
    .orderBy(desc(shortlistShares.createdAt)).limit(300);
  const items = rows.length ? await db.select({ i: shareItems, a: applications, u: users }).from(shareItems)
    .innerJoin(applications, eq(applications.id, shareItems.applicationId)).innerJoin(users, eq(users.id, applications.userId))
    .where(inArray(shareItems.shareId, rows.map((r) => r.s.id))) : [];
  res.json({
    items: rows.map(({ s, cl, c }) => {
      const { passcodeHash, ...rest } = s;
      return {
        ...rest, hasPasscode: !!passcodeHash, url: shareUrl(s.token), client: cl, casting: c,
        talents: items.filter((x) => x.i.shareId === s.id).map(({ i, a, u }) => ({ applicationId: a.id, status: a.status, pick: i.pick, comment: i.comment, pickedAt: i.pickedAt, talent: { ...publicUser(u), heightCm: u.heightCm } })),
      };
    }),
  });
}));

/* ---------------------------- Create / edit ---------------------------- */

router.post('/', ah(async (req, res) => {
  const body = parse(adminInput, req.body);
  await assertSafeCasting(body, false);
  if (body.status === 'SCHEDULED' && (!body.publishAt || body.publishAt <= new Date())) throw badRequest('Pick a future publish time');
  const { roles, status, ...data } = body;
  const [c] = await db.insert(castings).values({ ...data, code: await nextCastingCode('CH'), status: status === 'LIVE' ? 'DRAFT' : status, createdByAdminId: req.admin!.id }).returning();
  try { await saveRoles(c.id, roles); } catch (e) { await db.delete(castings).where(eq(castings.id, c.id)); throw e; }
  let alerted = 0;
  if (status === 'LIVE') alerted = (await goLive(c)).alerted;
  await audit(req, 'castings', `Created casting (${status.toLowerCase()})`, `${c.code} ${c.title}`);
  res.status(201).json({ casting: await full(await load(c.id)), alerted });
}));

router.get('/:id', ah(async (req, res) => {
  res.json({ casting: await full(await load(req.params.id)) });
}));

router.patch('/:id', ah(async (req, res) => {
  const c = await load(req.params.id);
  const body = parse(adminInput.partial(), req.body);
  if (body.title || body.description || body.budget) await assertSafeCasting({ title: body.title ?? c.title, description: body.description ?? c.description, budget: body.budget ?? c.budget }, !!c.postedByUserId);
  const { roles, status, ...data } = body;
  if (Object.keys(data).length) await db.update(castings).set(data).where(eq(castings.id, c.id));
  if (roles) await saveRoles(c.id, roles);
  if (status && status !== c.status) {
    if (status === 'LIVE') await goLive(await load(c.id));
    else await db.update(castings).set({ status }).where(eq(castings.id, c.id));
  }
  await audit(req, 'castings', `Edited casting (${Object.keys(body).join(', ')})`, `${c.code} ${c.title}`);
  res.json({ casting: await full(await load(c.id)) });
}));

router.post('/:id/publish', ah(async (req, res) => {
  const c = await load(req.params.id);
  if (c.deadline <= new Date()) throw badRequest('The last date has passed. Change it before publishing.');
  const { alerted } = await goLive(c);
  await audit(req, 'castings', 'Published casting', `${c.code} ${c.title}`);
  res.json({ casting: await full(await load(c.id)), alerted });
}));

for (const [path, status, label] of [['close', 'CLOSED', 'Closed'], ['archive', 'ARCHIVED', 'Archived'], ['unpublish', 'DRAFT', 'Unpublished']] as const) {
  router.post(`/:id/${path}`, ah(async (req, res) => {
    const c = await load(req.params.id);
    await db.update(castings).set({ status }).where(eq(castings.id, c.id));
    await audit(req, 'castings', `${label} casting`, `${c.code} ${c.title}`);
    res.json({ casting: await full(await load(c.id)) });
  }));
}

router.post('/:id/duplicate', ah(async (req, res) => {
  const c = await load(req.params.id);
  const roles = await db.select().from(castingRoles).where(eq(castingRoles.castingId, c.id));
  const { id: _id, code: _code, createdAt: _ca, updatedAt: _ua, views: _v, publishedAt: _p, ...rest } = c;
  const [copy] = await db.insert(castings).values({ ...rest, code: await nextCastingCode('CH'), title: `${c.title} (copy)`, status: 'DRAFT', postedByUserId: null, createdByAdminId: req.admin!.id, reviewNote: '' }).returning();
  if (roles.length) await db.insert(castingRoles).values(roles.map(({ id: _rid, castingId: _cid, ...r }) => ({ ...r, castingId: copy.id })));
  await audit(req, 'castings', 'Duplicated casting', `${c.code} → ${copy.code}`);
  res.status(201).json({ casting: await full(copy) });
}));

router.delete('/:id', ah(async (req, res) => {
  const c = await load(req.params.id);
  const [{ n }] = await db.select({ n: count() }).from(applications).where(eq(applications.castingId, c.id));
  if (n > 0) throw badRequest('This casting has applicants. Archive it instead.');
  await db.delete(castings).where(eq(castings.id, c.id));
  await audit(req, 'castings', 'Deleted casting', `${c.code} ${c.title}`);
  res.json({ ok: true });
}));

/** Talent Search → "Invite to apply": an in-app notification with a link to the casting. */
router.post('/:id/invite', ah(async (req, res) => {
  const c = await load(req.params.id);
  if (c.status !== 'LIVE') throw badRequest('Only live castings can be shared with talent');
  const { userIds, message } = parse(z.object({ userIds: z.array(z.string()).min(1).max(500), message: z.string().trim().max(300).default('') }), req.body);
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, userIds), eq(users.status, 'ACTIVE')));
  const already = new Set((await db.select({ u: applications.userId }).from(applications).where(and(eq(applications.castingId, c.id), inArray(applications.userId, userIds)))).map((x) => x.u));
  const targets = rows.filter((r) => !already.has(r.id));
  for (const t of targets) await notify(t.id, 'casting_invite', `You're invited to audition: ${c.title}`, message || `The ${await brandName()} team thinks you're a good fit. Apply before ${c.deadline.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}.`, `/casting-calls/${c.code}`);
  await audit(req, 'castings', `Invited ${targets.length} talent to apply`, `${c.code} ${c.title}`);
  res.json({ invited: targets.length, skipped: userIds.length - targets.length });
}));

/* ---------------------------- Member casting review ---------------------------- */

const note = z.object({ note: z.string().trim().min(3, 'Tell the member what to fix').max(1000) });

router.post('/:id/approve', ah(async (req, res) => {
  const c = await load(req.params.id);
  if (!c.postedByUserId) throw badRequest('Only castings posted by members need approval');
  if (!['PENDING', 'CHANGES', 'REJECTED'].includes(c.status)) throw badRequest('This casting is not waiting for review');
  if (c.deadline <= new Date()) throw badRequest('The last date has passed. Ask the member to change it.');
  const body = parse(z.object({ featured: z.boolean().optional(), urgent: z.boolean().optional(), sendAlert: z.boolean().optional() }), req.body ?? {});
  await db.update(castings).set({ ...body, reviewNote: '' }).where(eq(castings.id, c.id));
  const { alerted } = await goLive(await load(c.id));
  await notifyRule('casting_review', c.postedByUserId, { casting: c.title, result: 'approved and is now live' }, `/my-castings/${c.id}`);
  await audit(req, 'castings', 'Approved member casting', `${c.code} ${c.title}`);
  res.json({ casting: await full(await load(c.id)), alerted });
}));

router.post('/:id/request-changes', ah(async (req, res) => {
  const c = await load(req.params.id);
  if (!c.postedByUserId) throw badRequest('Only castings posted by members need approval');
  const { note: n } = parse(note, req.body);
  await db.update(castings).set({ status: 'CHANGES', reviewNote: n }).where(eq(castings.id, c.id));
  await notify(c.postedByUserId, 'casting_review', 'Changes needed on your casting', `“${c.title}”: ${n}`, `/my-castings/${c.id}`);
  await audit(req, 'castings', `Asked for changes: ${n}`, `${c.code} ${c.title}`);
  res.json({ casting: await full(await load(c.id)) });
}));

router.post('/:id/reject', ah(async (req, res) => {
  const c = await load(req.params.id);
  if (!c.postedByUserId) throw badRequest('Only castings posted by members need approval');
  const { note: n } = parse(note, req.body);
  await db.update(castings).set({ status: 'REJECTED', reviewNote: n }).where(eq(castings.id, c.id));
  await notifyRule('casting_review', c.postedByUserId, { casting: c.title, result: `not approved: ${n}` }, `/my-castings/${c.id}`);
  await audit(req, 'castings', `Rejected member casting: ${n}`, `${c.code} ${c.title}`);
  res.json({ casting: await full(await load(c.id)) });
}));

/* ---------------------------- Audition days & slots ---------------------------- */
// Shared with Pro members' own castings: see ./schedule.ts
router.use('/', scheduleRoutes('admin', async (_req, id) => load(id)));

/* ---------------------------- Client shortlist links ---------------------------- */

router.get('/:id/shares', ah(async (req, res) => {
  const c = await load(req.params.id);
  const rows = await db.select({ s: shortlistShares, cl: clients }).from(shortlistShares).innerJoin(clients, eq(clients.id, shortlistShares.clientId)).where(eq(shortlistShares.castingId, c.id)).orderBy(desc(shortlistShares.createdAt));
  const items = rows.length ? await db.select().from(shareItems).where(inArray(shareItems.shareId, rows.map((r) => r.s.id))) : [];
  res.json({
    items: rows.map(({ s, cl }) => {
      const mine = items.filter((i) => i.shareId === s.id);
      const { passcodeHash, ...rest } = s;
      return { ...rest, hasPasscode: !!passcodeHash, url: shareUrl(s.token), client: cl, talents: mine.length, picks: { yes: mine.filter((i) => i.pick === 'yes').length, maybe: mine.filter((i) => i.pick === 'maybe').length, no: mine.filter((i) => i.pick === 'no').length }, feedback: mine.filter((i) => i.pick || i.comment) };
    }),
  });
}));

const shareUrl = (t: string) => `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/share/${t}`;

router.post('/:id/shares', ah(async (req, res) => {
  const c = await load(req.params.id);
  const body = parse(z.object({
    clientId: z.string().min(1), title: z.string().trim().min(2).max(140), message: z.string().max(1000).default(''),
    applicationIds: z.array(z.string()).min(1, 'Pick at least one applicant').max(100), roleId: z.string().nullable().optional(),
    showVideos: z.boolean().default(true), showMeasurements: z.boolean().default(true), allowDownload: z.boolean().default(false),
    passcode: z.string().regex(/^\d{4,8}$/, 'Passcode: 4–8 digits').optional().or(z.literal('')), expiresInDays: z.coerce.number().int().min(1).max(90).default(14),
  }), req.body);
  const client = await db.query.clients.findFirst({ where: eq(clients.id, body.clientId) });
  if (!client) throw notFound('Client');
  const own = await db.select({ id: applications.id }).from(applications).where(and(eq(applications.castingId, c.id), inArray(applications.id, body.applicationIds)));
  if (!own.length) throw badRequest('None of these applicants belong to this casting');
  const token = randomCode(10).toLowerCase();
  const [share] = await db.insert(shortlistShares).values({
    token, castingId: c.id, roleId: body.roleId ?? null, clientId: client.id, title: body.title, message: body.message,
    showVideos: body.showVideos, showMeasurements: body.showMeasurements, allowDownload: body.allowDownload,
    passcodeHash: body.passcode ? await bcrypt.hash(body.passcode, 8) : null, expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000), createdByName: req.admin!.name,
  }).returning();
  await db.insert(shareItems).values(own.map((o) => ({ shareId: share.id, applicationId: o.id })));
  await audit(req, 'castings', `Shared ${own.length} talents with ${client.company}`, c.code);
  const { passcodeHash: _p, ...rest } = share;
  res.status(201).json({ share: { ...rest, url: shareUrl(token), talents: own.length } });
}));

router.patch('/:id/shares/:shareId', ah(async (req, res) => {
  const c = await load(req.params.id);
  const body = parse(z.object({ extendDays: z.coerce.number().int().min(1).max(90).optional(), revoke: z.boolean().optional(), reopen: z.boolean().optional(), addApplicationIds: z.array(z.string()).max(100).optional() }), req.body);
  const s = await db.query.shortlistShares.findFirst({ where: and(eq(shortlistShares.id, req.params.shareId), eq(shortlistShares.castingId, c.id)) });
  if (!s) throw notFound('Share link');
  const patch: Partial<typeof shortlistShares.$inferInsert> = {};
  if (body.extendDays) patch.expiresAt = new Date(Math.max(Date.now(), s.expiresAt.getTime()) + body.extendDays * 86_400_000);
  if (body.revoke) patch.revokedAt = new Date();
  if (body.reopen) { patch.revokedAt = null; patch.submittedAt = null; }
  if (Object.keys(patch).length) await db.update(shortlistShares).set(patch).where(eq(shortlistShares.id, s.id));
  if (body.addApplicationIds?.length) {
    const own = await db.select({ id: applications.id }).from(applications).where(and(eq(applications.castingId, c.id), inArray(applications.id, body.addApplicationIds)));
    if (own.length) await db.insert(shareItems).values(own.map((o) => ({ shareId: s.id, applicationId: o.id }))).onConflictDoNothing();
  }
  await audit(req, 'castings', body.revoke ? 'Turned off share link' : 'Updated share link', `${c.code} ${s.title}`);
  res.json({ ok: true });
}));

// Applicants pipeline (same as member posters, plus admin-only notes and masked phones).
router.use('/', pipelineRoutes('admin', async (_req, id) => load(id)));

/* ============================ Clients ============================ */
export const clientsRouter = Router();
clientsRouter.use(requireAdmin, requirePerm('castings'));

const clientInput = z.object({
  company: z.string().trim().min(2).max(120), contactName: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(120).or(z.literal('')).default(''), phone: z.string().trim().max(20).default(''),
  city: z.string().trim().max(60).default(''), notes: z.string().max(2000).default(''),
});

clientsRouter.get('/', ah(async (_req, res) => {
  const rows = await db.select().from(clients).orderBy(asc(clients.company));
  const counts = await db.select({ id: castings.clientId, n: count() }).from(castings).where(isNotNull(castings.clientId)).groupBy(castings.clientId);
  const cm = new Map(counts.map((c) => [c.id, c.n]));
  res.json({ items: rows.map((r) => ({ ...r, castings: cm.get(r.id) ?? 0 })) });
}));

clientsRouter.post('/', ah(async (req, res) => {
  const body = parse(clientInput, req.body);
  const [item] = await db.insert(clients).values(body).returning();
  await audit(req, 'castings', 'Added client', body.company);
  res.status(201).json({ item });
}));

clientsRouter.patch('/:id', ah(async (req, res) => {
  const body = parse(clientInput.partial(), req.body);
  const [item] = await db.update(clients).set(body).where(eq(clients.id, req.params.id)).returning();
  if (!item) throw notFound('Client');
  res.json({ item });
}));

clientsRouter.delete('/:id', ah(async (req, res) => {
  const [{ n }] = await db.select({ n: count() }).from(shortlistShares).where(eq(shortlistShares.clientId, req.params.id));
  if (n > 0) throw badRequest('This client has share links. Turn them off first, or keep the client.');
  const [item] = await db.delete(clients).where(eq(clients.id, req.params.id)).returning();
  if (!item) throw notFound('Client');
  await audit(req, 'castings', 'Deleted client', item.company);
  res.json({ ok: true });
}));

export default router;
