import { Router, type Request } from 'express';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import type { Casting } from '../../db/schema';
import { ah, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { notify } from '../../lib/notify';
import { publicUser } from '../../lib/serialize';
import { emitToAdmins } from '../../realtime';

const { applications, users, auditionDays, auditionSlots } = schema;

const toMins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMins = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time like 10:00');
const t12 = (t: string) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const niceDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

/** Times (HH:MM) from start to end in steps of slotMins, skipping an optional break. */
export function makeSlots(start: string, end: string, slotMins: number, breakStart?: string, breakEnd?: string) {
  const out: string[] = [];
  for (let t = toMins(start); t + slotMins <= toMins(end); t += slotMins) {
    if (breakStart && breakEnd && t < toMins(breakEnd) && t + slotMins > toMins(breakStart)) continue;
    out.push(fromMins(t));
  }
  return out;
}

const dayInput = z.object({
  title: z.string().trim().min(2).max(120), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date as YYYY-MM-DD'),
  start: hhmm, end: hhmm, slotMins: z.coerce.number().int().min(5).max(240),
  breakStart: hhmm.optional(), breakEnd: hhmm.optional(),
  mode: z.enum(['In person', 'Online']).default('In person'), venue: z.string().trim().min(2).max(300), bring: z.string().max(500).default(''),
}).refine((d) => toMins(d.start) < toMins(d.end), 'End time must be after start time')
  .refine((d) => d.date >= new Date().toISOString().slice(0, 10), 'Pick today or a later date');

type Who = 'admin' | 'poster';

/**
 * Audition days and time slots, shared by the admin panel (any casting) and Pro members (their own castings).
 * Once a slot is booked it is confirmed: only the casting team can move or release it.
 */
export function scheduleRoutes(who: Who, load: (req: Request, id: string) => Promise<Casting>, guardWrite?: (req: Request) => Promise<void>) {
  const r = Router();
  const write = async (req: Request) => { if (guardWrite) await guardWrite(req); };
  const log = (req: Request, action: string, target: string) => (who === 'admin' ? audit(req, 'castings', action, target) : Promise.resolve());

  async function loadDay(castingId: string, dayId: string) {
    const d = await db.query.auditionDays.findFirst({ where: and(eq(auditionDays.id, dayId), eq(auditionDays.castingId, castingId)) });
    if (!d) throw notFound('Audition day');
    return d;
  }

  r.get('/:id/days', ah(async (req, res) => {
    const c = await load(req, req.params.id);
    const days = await db.select().from(auditionDays).where(eq(auditionDays.castingId, c.id)).orderBy(asc(auditionDays.date));
    const slots = days.length ? await db.select({ s: auditionSlots, a: applications, u: users }).from(auditionSlots)
      .leftJoin(applications, eq(applications.id, auditionSlots.applicationId)).leftJoin(users, eq(users.id, applications.userId))
      .where(inArray(auditionSlots.dayId, days.map((d) => d.id))).orderBy(asc(auditionSlots.time)) : [];
    // Round-2 applicants without a slot yet, so the team can assign them.
    const unbooked = await db.select({ a: applications, u: users }).from(applications).innerJoin(users, eq(users.id, applications.userId))
      .where(and(eq(applications.castingId, c.id), eq(applications.status, 'ROUND2'), sql`${applications.id} NOT IN (SELECT application_id FROM audition_slots WHERE application_id IS NOT NULL)`));
    res.json({
      days: days.map((d) => ({ ...d, slots: slots.filter((x) => x.s.dayId === d.id).map((x) => ({ ...x.s, talent: x.u ? { applicationId: x.a!.id, ...publicUser(x.u) } : null })) })),
      unbooked: unbooked.map((x) => ({ applicationId: x.a.id, ...publicUser(x.u) })),
      changeRequests: slots.filter((x) => x.s.changeRequest && x.u).length,
    });
  }));

  r.post('/:id/days', ah(async (req, res) => {
    await write(req);
    const c = await load(req, req.params.id);
    const body = parse(dayInput, req.body);
    const times = makeSlots(body.start, body.end, body.slotMins, body.breakStart, body.breakEnd);
    if (!times.length) throw badRequest('No slots fit between these times');
    if (times.length > 200) throw badRequest('That is more than 200 slots. Use a longer slot length or a shorter day.');
    const { breakStart: _b1, breakEnd: _b2, ...data } = body;
    const [day] = await db.insert(auditionDays).values({ ...data, castingId: c.id }).returning();
    await db.insert(auditionSlots).values(times.map((time) => ({ dayId: day.id, time })));
    // Tell round-2 applicants without a slot that they can book now.
    const waiting = await db.select({ userId: applications.userId }).from(applications)
      .where(and(eq(applications.castingId, c.id), eq(applications.status, 'ROUND2'), sql`${applications.id} NOT IN (SELECT application_id FROM audition_slots WHERE application_id IS NOT NULL)`));
    for (const w of waiting) await notify(w.userId, 'round2', `Book your audition slot: ${c.title}`, `${niceDate(body.date)} · ${body.mode === 'Online' ? 'Online' : body.venue}. Pick a time before slots fill up.`, '/applications');
    await log(req, `Added audition day ${body.date} (${times.length} slots)`, c.code);
    res.status(201).json({ day, slots: times.length, notified: waiting.length });
  }));

  r.patch('/:id/days/:dayId', ah(async (req, res) => {
    await write(req);
    const c = await load(req, req.params.id);
    await loadDay(c.id, req.params.dayId);
    const body = parse(z.object({ title: z.string().trim().min(2).max(120), venue: z.string().trim().min(2).max(300), bring: z.string().max(500), mode: z.enum(['In person', 'Online']) }).partial(), req.body);
    const [day] = await db.update(auditionDays).set(body).where(eq(auditionDays.id, req.params.dayId)).returning();
    res.json({ day });
  }));

  r.delete('/:id/days/:dayId', ah(async (req, res) => {
    await write(req);
    const c = await load(req, req.params.id);
    const d = await loadDay(c.id, req.params.dayId);
    const booked = await db.select({ a: applications.userId }).from(auditionSlots).innerJoin(applications, eq(applications.id, auditionSlots.applicationId)).where(eq(auditionSlots.dayId, d.id));
    await db.delete(auditionDays).where(eq(auditionDays.id, d.id));
    for (const b of booked) await notify(b.a, 'round2', 'Audition slot cancelled', `The ${niceDate(d.date)} audition for “${c.title}” was cancelled. Please book a new slot.`, '/applications');
    await log(req, `Deleted audition day ${d.date}`, c.code);
    res.json({ ok: true, notified: booked.length });
  }));

  /** Assign / move / release a slot, or mark attendance. The applicant is told about every change. */
  r.patch('/:id/days/:dayId/slots/:slotId', ah(async (req, res) => {
    await write(req);
    const c = await load(req, req.params.id);
    const d = await loadDay(c.id, req.params.dayId);
    const body = parse(z.object({ applicationId: z.string().nullable().optional(), status: z.enum(['OPEN', 'BOOKED', 'CHECKED_IN', 'NO_SHOW', 'DONE']).optional(), note: z.string().max(300).optional() }), req.body);
    const cur = await db.query.auditionSlots.findFirst({ where: and(eq(auditionSlots.id, req.params.slotId), eq(auditionSlots.dayId, d.id)) });
    if (!cur) throw notFound('Slot');
    const patch: Partial<typeof auditionSlots.$inferInsert> = {};
    let tellNew: string | null = null;
    let tellReleased: string | null = null;
    if (body.applicationId !== undefined && body.applicationId !== cur.applicationId) {
      if (cur.applicationId) tellReleased = cur.applicationId;
      if (body.applicationId) {
        const a = await db.query.applications.findFirst({ where: and(eq(applications.id, body.applicationId), eq(applications.castingId, c.id)) });
        if (!a) throw notFound('Applicant');
        await db.update(auditionSlots).set({ applicationId: null, status: 'OPEN', changeRequest: null, changeRequestedAt: null }).where(eq(auditionSlots.applicationId, a.id));
        if (a.status !== 'ROUND2') await db.update(applications).set({ status: 'ROUND2' }).where(eq(applications.id, a.id));
        patch.applicationId = a.id; patch.status = 'BOOKED'; tellNew = a.id;
      } else { patch.applicationId = null; patch.status = 'OPEN'; }
      patch.changeRequest = null; patch.changeRequestedAt = null;
    }
    if (body.status) patch.status = body.status;
    if (body.note !== undefined) patch.note = body.note;
    const [slot] = await db.update(auditionSlots).set(patch).where(eq(auditionSlots.id, cur.id)).returning();
    const userOf = async (appId: string) => (await db.query.applications.findFirst({ where: eq(applications.id, appId), columns: { userId: true } }))?.userId;
    if (tellReleased && tellReleased !== tellNew) {
      const u = await userOf(tellReleased);
      if (u) await notify(u, 'round2', `Pick a new audition time: ${c.title}`, cur.changeRequest ? 'Your change request was accepted. Please book a new slot.' : `Your ${t12(cur.time)} slot on ${niceDate(d.date)} was released by the casting team. Please book a new time.`, '/applications');
    }
    if (tellNew) {
      const u = await userOf(tellNew);
      if (u) await notify(u, 'round2', `Your audition slot: ${niceDate(d.date)}, ${t12(slot.time)}`, `${c.title} · ${d.mode === 'Online' ? 'Online' : d.venue}${d.bring ? ` · Bring: ${d.bring}` : ''}`, '/applications');
    }
    res.json({ slot });
  }));

  /** Reminder to everyone booked on this day. */
  r.post('/:id/days/:dayId/remind', ah(async (req, res) => {
    await write(req);
    const c = await load(req, req.params.id);
    const d = await loadDay(c.id, req.params.dayId);
    const rows = await db.select({ userId: applications.userId, time: auditionSlots.time }).from(auditionSlots).innerJoin(applications, eq(applications.id, auditionSlots.applicationId)).where(eq(auditionSlots.dayId, d.id));
    for (const x of rows) await notify(x.userId, 'round2', `Audition reminder: ${niceDate(d.date)} at ${t12(x.time)}`, `${c.title} · ${d.mode === 'Online' ? 'Online' : d.venue}${d.bring ? ` · Bring: ${d.bring}` : ''}`, '/applications');
    await db.update(auditionDays).set({ remindersSentAt: new Date() }).where(eq(auditionDays.id, d.id));
    await log(req, `Sent reminders for ${d.date} (${rows.length})`, c.code);
    res.json({ sent: rows.length });
  }));

  return r;
}

/** Tells whoever runs the casting that an applicant asked to change a confirmed slot. */
export async function announceChangeRequest(c: Casting, who: string, time: string, date: string, reason: string) {
  const text = `${who} asked to change their ${t12(time)} slot on ${niceDate(date)}: “${reason}”`;
  if (c.postedByUserId) await notify(c.postedByUserId, 'round2', `Slot change request · ${c.title}`, text, `/my-castings/${c.id}?tab=schedule`);
  emitToAdmins('schedule:change', { castingId: c.id, text });
}
