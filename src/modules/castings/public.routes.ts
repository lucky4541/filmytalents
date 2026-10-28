import { Router } from 'express';
import { and, arrayOverlaps, asc, count, desc, eq, gt, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound, paymentRequired, tooMany } from '../../lib/errors';
import { runUpload, saveFile, uploader, removeFile } from '../../lib/storage';
import { isPaid, optionalMember, requireMember } from '../../middleware/auth';
import { ageFrom } from '../../lib/serialize';
import { countApplication, earlyUntil, isOpen, monthlyLimit, publicCasting, publishDue, rolesFor, usedThisMonth } from './service';
import { announceChangeRequest } from './schedule';

const { castings, castingRoles, applications, auditionDays, auditionSlots, round2Invites } = schema;

/* ============================ Castings (public) ============================ */
export const publicCastings = Router();

const csv = z.string().max(300).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).optional();
const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  city: csv, projectType: csv, language: csv,
  gender: z.enum(['Male', 'Female']).optional(),
  age: z.coerce.number().int().min(0).max(100).optional(),
  mode: z.enum(['In person', 'Online', 'Self tape']).optional(),
  proOnly: z.enum(['true', 'false']).optional(),
  featured: z.enum(['true', 'false']).optional(),
  includeClosed: z.enum(['true', 'false']).optional(),
  forMe: z.enum(['true', 'false']).optional(),
  sort: z.enum(['new', 'deadline', 'popular']).default('new'),
});

/** Live castings. forMe=true matches the logged-in member's gender and age. */
publicCastings.get('/', optionalMember, ah(async (req, res) => {
  await publishDue();
  const f = parse(listQuery, req.query);
  const { page, limit, skip } = paging(req.query, 50);
  const w: SQL[] = [f.includeClosed === 'true' ? inArray(castings.status, ['LIVE', 'CLOSED']) : and(eq(castings.status, 'LIVE'), gt(castings.deadline, new Date()))!];
  // Pro early access: Free members and visitors don't see the casting until the window ends.
  if (!req.user || !isPaid(req.user)) w.push(sql`(${castings.proEarlyAccessHours} = 0 OR ${castings.publishedAt} + make_interval(hours => ${castings.proEarlyAccessHours}) <= now())`);
  if (f.q) w.push(or(ilike(castings.title, `%${f.q}%`), ilike(castings.production, `%${f.q}%`), ilike(castings.code, `%${f.q}%`), ilike(castings.description, `%${f.q}%`))!);
  if (f.city?.length) w.push(or(...f.city.map((c) => ilike(castings.location, `%${c}%`)))!);
  if (f.projectType?.length) w.push(inArray(castings.projectType, f.projectType));
  if (f.language?.length) w.push(arrayOverlaps(castings.languages, f.language));
  if (f.mode) w.push(eq(castings.mode, f.mode));
  if (f.proOnly === 'true') w.push(eq(castings.visibility, 'PRO'));
  if (f.featured === 'true') w.push(eq(castings.featured, true));
  let gender = f.gender;
  let age = f.age;
  if (f.forMe === 'true' && req.user) {
    gender = (req.user.gender as 'Male' | 'Female' | undefined) ?? gender;
    age = req.user.dob ? ageFrom(req.user.dob) : age;
  }
  if (gender || age !== undefined) {
    const roleW: SQL[] = [sql`${castingRoles.castingId} = ${castings.id}`];
    if (gender) roleW.push(inArray(castingRoles.gender, [gender, 'Any']));
    if (age !== undefined) roleW.push(sql`${castingRoles.ageMin} <= ${age} AND ${castingRoles.ageMax} >= ${age}`);
    w.push(sql`EXISTS (SELECT 1 FROM ${castingRoles} WHERE ${and(...roleW)})`);
  }
  const where = and(...w);
  const order = f.sort === 'deadline' ? [asc(castings.deadline)] : f.sort === 'popular' ? [desc(castings.views)] : [desc(castings.featured), desc(castings.urgent), desc(castings.publishedAt)];
  const [{ n }] = await db.select({ n: count() }).from(castings).where(where);
  const rows = await db.select().from(castings).where(where).orderBy(...order).limit(limit).offset(skip);
  const roles = await rolesFor(rows.map((r) => r.id));
  let applied = new Set<string>();
  if (req.user && rows.length) {
    const mine = await db.select({ c: applications.castingId }).from(applications).where(and(eq(applications.userId, req.user.id), inArray(applications.castingId, rows.map((r) => r.id))));
    applied = new Set(mine.map((m) => m.c));
  }
  res.json(pageResult(rows.map((c) => ({ ...publicCasting(c, roles.get(c.id) ?? [], req.user), applied: applied.has(c.id) })), n, page, limit));
}));

async function liveByCode(code: string) {
  await publishDue();
  const c = await db.query.castings.findFirst({ where: eq(castings.code, code.toUpperCase()) });
  if (!c || !['LIVE', 'CLOSED'].includes(c.status)) throw notFound('Casting');
  return c;
}

publicCastings.get('/:code', optionalMember, ah(async (req, res) => {
  const c = await liveByCode(req.params.code);
  const roles = await db.select().from(castingRoles).where(eq(castingRoles.castingId, c.id));
  await db.update(castings).set({ views: sql`${castings.views} + 1` }).where(eq(castings.id, c.id));
  const mine = req.user ? await db.query.applications.findFirst({ where: and(eq(applications.castingId, c.id), eq(applications.userId, req.user.id)) }) : undefined;
  const isOwner = !!req.user && c.postedByUserId === req.user.id;
  let limit: { used: number; max: number | null } | null = null;
  if (req.user) limit = { used: await usedThisMonth(req.user), max: await monthlyLimit(req.user) };
  res.json({ casting: publicCasting(c, roles, req.user), myApplication: mine ? { id: mine.id, status: mine.status, roleId: mine.roleId, appliedAt: mine.createdAt } : null, isOwner, applicationsThisMonth: limit });
}));

/**
 * Apply. JSON { roleId, note?, tapeUrl? } or multipart with a "tape" video file.
 * Free: limited per month (Admin → Plans). Pro-only castings and early-access castings need Pro.
 */
publicCastings.post('/:code/apply', requireMember, ah(async (req, res) => {
  const c = await liveByCode(req.params.code);
  const u = req.user!;
  if (!isOpen(c)) throw badRequest('Applications for this casting are closed');
  if (c.postedByUserId === u.id) throw badRequest('You can’t apply to your own casting');
  if (!u.name) throw badRequest('Add your name to your profile before applying');
  const pro = isPaid(u);
  if (c.visibility === 'PRO' && !pro) throw paymentRequired('This casting is for Pro members. Upgrade to apply.');
  const early = earlyUntil(c);
  if (early && early > new Date() && !pro) throw paymentRequired(`Pro members get early access. Free members can apply after ${early.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.`);
  const max = await monthlyLimit(u);
  if (max !== null && (await usedThisMonth(u)) >= max) throw tooMany(`You have used all ${max} free applications this month. Upgrade to Pro for unlimited applications.`);
  const exists = await db.query.applications.findFirst({ where: and(eq(applications.castingId, c.id), eq(applications.userId, u.id)) });
  if (exists) throw conflict('You have already applied to this casting');

  const multipart = req.is('multipart/form-data');
  if (multipart) await runUpload(uploader('video').single('tape'), req, res);
  const body = parse(z.object({ roleId: z.string().min(1, 'Choose a role'), note: z.string().trim().max(1000).default(''), tapeUrl: z.string().url().max(500).optional().or(z.literal('')) }), req.body);
  const role = await db.query.castingRoles.findFirst({ where: and(eq(castingRoles.id, body.roleId), eq(castingRoles.castingId, c.id)) });
  if (!role) throw badRequest('This role is not part of the casting');
  if (role.gender !== 'Any' && u.gender && u.gender !== role.gender) throw badRequest(`This role is for ${role.gender.toLowerCase()} talent`);

  let tapeUrl = body.tapeUrl || null;
  if (req.file) {
    if (!pro) throw paymentRequired('Uploading a video tape is a Pro feature. You can paste a YouTube / Drive link instead.');
    tapeUrl = await saveFile(req.file, 'video', `tapes/${c.id}`);
  }
  const [app] = await db.insert(applications).values({ castingId: c.id, roleId: role.id, userId: u.id, note: body.note, tapeUrl }).returning();
  await countApplication(u);
  res.status(201).json({ application: app });
}));

/* ============================ My applications ============================ */
export const myApplications = Router();
myApplications.use(requireMember);

myApplications.get('/', ah(async (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
  const w = and(eq(applications.userId, req.user!.id), status ? eq(applications.status, status as 'APPLIED') : undefined);
  const rows = await db.select({ a: applications, c: castings, r: castingRoles, inv: round2Invites }).from(applications)
    .innerJoin(castings, eq(castings.id, applications.castingId)).innerJoin(castingRoles, eq(castingRoles.id, applications.roleId))
    .leftJoin(round2Invites, eq(round2Invites.applicationId, applications.id))
    .where(w).orderBy(desc(applications.createdAt)).limit(200);
  const slots = rows.length ? await db.select({ s: auditionSlots, d: auditionDays }).from(auditionSlots).innerJoin(auditionDays, eq(auditionDays.id, auditionSlots.dayId)).where(inArray(auditionSlots.applicationId, rows.map((r) => r.a.id))) : [];
  const slotBy = new Map(slots.map((s) => [s.s.applicationId!, s]));
  const used = await usedThisMonth(req.user!);
  res.json({
    applicationsThisMonth: { used, max: await monthlyLimit(req.user!) },
    items: rows.map(({ a, c, r, inv }) => {
      const s = slotBy.get(a.id);
      return {
        id: a.id, status: a.status, note: a.note, tapeUrl: a.tapeUrl, appliedAt: a.createdAt, updatedAt: a.updatedAt,
        // "VIEWED" is internal; members just see "Applied".
        displayStatus: a.status === 'VIEWED' ? 'APPLIED' : a.status,
        casting: { id: c.id, code: c.code, title: c.title, production: c.showProductionAs === 'confidential' ? 'Confidential production' : c.production, location: c.location, deadline: c.deadline, status: c.status, posterUrl: c.posterUrl },
        role: { id: r.id, name: r.name },
        round2: inv ? { date: inv.date, venue: inv.venue, bring: inv.bring } : null,
        slot: s ? { id: s.s.id, dayId: s.d.id, date: s.d.date, time: s.s.time, venue: s.d.venue, mode: s.d.mode, bring: s.d.bring, title: s.d.title, status: s.s.status, confirmed: true, changeRequest: s.s.changeRequest, changeRequestedAt: s.s.changeRequestedAt } : null,
      };
    }),
  });
}));

async function mine(id: string, userId: string) {
  const a = await db.query.applications.findFirst({ where: and(eq(applications.id, id), eq(applications.userId, userId)) });
  if (!a) throw notFound('Application');
  return a;
}

/** Withdraw while nobody has acted on it yet. Doesn't give back the monthly count. */
myApplications.delete('/:id', ah(async (req, res) => {
  const a = await mine(req.params.id, req.user!.id);
  if (!['APPLIED', 'VIEWED'].includes(a.status)) throw forbidden('You can’t withdraw after the casting team has acted on your application');
  await db.delete(applications).where(eq(applications.id, a.id));
  await removeFile(a.tapeUrl);
  res.json({ ok: true });
}));

/** Open round-2 slots for my application. */
myApplications.get('/:id/slots', ah(async (req, res) => {
  const a = await mine(req.params.id, req.user!.id);
  if (a.status !== 'ROUND2') throw forbidden('Slots open once you are invited to round 2');
  const today = new Date().toISOString().slice(0, 10);
  const days = await db.select().from(auditionDays).where(and(eq(auditionDays.castingId, a.castingId), sql`${auditionDays.date} >= ${today}`)).orderBy(asc(auditionDays.date));
  const slots = days.length ? await db.select().from(auditionSlots).where(inArray(auditionSlots.dayId, days.map((d) => d.id))).orderBy(asc(auditionSlots.time)) : [];
  res.json({
    days: days.map((d) => ({ id: d.id, title: d.title, date: d.date, mode: d.mode, venue: d.venue, bring: d.bring, slots: slots.filter((s) => s.dayId === d.id).map((s) => ({ id: s.id, time: s.time, free: s.status === 'OPEN' && !s.applicationId, mine: s.applicationId === a.id })) })),
  });
}));

/**
 * Book my round-2 slot. Booking confirms it: after that only the casting team can move or release it,
 * so applicants can't keep switching times (others plan around a full schedule).
 */
myApplications.post('/:id/book', ah(async (req, res) => {
  const a = await mine(req.params.id, req.user!.id);
  if (a.status !== 'ROUND2') throw forbidden('Slots open once you are invited to round 2');
  const { slotId } = parse(z.object({ slotId: z.string().min(1) }), req.body);
  const already = await db.query.auditionSlots.findFirst({ where: eq(auditionSlots.applicationId, a.id) });
  if (already) throw conflict('Your slot is already confirmed. To change it, send a change request to the casting team.');
  const slot = await db.select({ s: auditionSlots, d: auditionDays }).from(auditionSlots).innerJoin(auditionDays, eq(auditionDays.id, auditionSlots.dayId)).where(eq(auditionSlots.id, slotId)).then((r) => r[0]);
  if (!slot || slot.d.castingId !== a.castingId) throw notFound('Slot');
  if (slot.d.date < new Date().toISOString().slice(0, 10)) throw badRequest('This audition day has passed');
  const [booked] = await db.update(auditionSlots).set({ applicationId: a.id, status: 'BOOKED' })
    .where(and(eq(auditionSlots.id, slotId), sql`${auditionSlots.applicationId} IS NULL`, eq(auditionSlots.status, 'OPEN'))).returning();
  if (!booked) throw conflict('Someone just booked this slot. Please pick another time.');
  res.json({ slot: { id: booked.id, time: booked.time, date: slot.d.date, venue: slot.d.venue, mode: slot.d.mode, confirmed: true } });
}));

/** A confirmed slot can't be cancelled by the applicant. */
myApplications.delete('/:id/book', ah(async () => {
  throw forbidden('Your slot is confirmed and can’t be cancelled here. Send a change request to the casting team instead.');
}));

/** Ask the casting team to change a confirmed slot. They decide; the slot stays booked until they act. */
myApplications.post('/:id/slot-change', ah(async (req, res) => {
  const a = await mine(req.params.id, req.user!.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(5, 'Tell the casting team why (at least 5 characters)').max(300) }), req.body);
  const row = await db.select({ s: auditionSlots, d: auditionDays }).from(auditionSlots).innerJoin(auditionDays, eq(auditionDays.id, auditionSlots.dayId)).where(eq(auditionSlots.applicationId, a.id)).then((r) => r[0]);
  if (!row) throw badRequest('You don’t have a booked slot');
  if (row.s.status !== 'BOOKED') throw badRequest('This audition has already happened');
  if (row.s.changeRequest) throw conflict('You already asked for a change. The casting team will reply soon.');
  await db.update(auditionSlots).set({ changeRequest: reason, changeRequestedAt: new Date() }).where(eq(auditionSlots.id, row.s.id));
  const c = (await db.query.castings.findFirst({ where: eq(castings.id, a.castingId) }))!;
  await announceChangeRequest(c, req.user!.name || 'An applicant', row.s.time, row.d.date, reason);
  res.json({ ok: true });
}));
