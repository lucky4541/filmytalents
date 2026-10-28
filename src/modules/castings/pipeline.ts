import { Router, type Request } from 'express';
import { and, asc, count, desc, eq, gte, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import type { Casting } from '../../db/schema';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { notifyRule } from '../../lib/notify';
import { audit } from '../../lib/audit';
import { PIPELINE, applicantView, setStatus } from './service';

const { applications, users, castingRoles, applicationNotes, round2Invites } = schema;

type Who = 'admin' | 'poster';

/**
 * Applicant pipeline routes, shared by the admin panel and by Pro members managing their own castings.
 * `load` returns the casting after checking the caller may manage it.
 */
export function pipelineRoutes(who: Who, load: (req: Request, id: string) => Promise<Casting>) {
  const r = Router();

  const listQuery = z.object({
    role: z.string().optional(),
    status: z.string().optional(),
    q: z.string().trim().max(80).optional(),
    minRating: z.coerce.number().int().min(0).max(5).optional(),
    sort: z.enum(['new', 'old', 'rating', 'name']).default('new'),
  });

  r.get('/:id/applicants', ah(async (req, res) => {
    const c = await load(req, req.params.id);
    const f = parse(listQuery, req.query);
    const { page, limit, skip } = paging(req.query, 200);
    const w: SQL[] = [eq(applications.castingId, c.id)];
    if (f.role && f.role !== 'all') w.push(eq(applications.roleId, f.role));
    if (f.status && f.status !== 'all') w.push(inArray(applications.status, f.status.toUpperCase().split(',') as (typeof PIPELINE)[number][]));
    if (f.q) w.push(or(ilike(users.name, `%${f.q}%`), ilike(users.code, `%${f.q}%`), ilike(users.city, `%${f.q}%`))!);
    if (f.minRating) w.push(gte(applications.rating, f.minRating));
    const where = and(...w);
    const order = { new: desc(applications.createdAt), old: asc(applications.createdAt), rating: desc(applications.rating), name: asc(users.name) }[f.sort];
    const [{ n }] = await db.select({ n: count() }).from(applications).innerJoin(users, eq(users.id, applications.userId)).where(where);
    const rows = await db.select({ a: applications, u: users, role: castingRoles, inv: round2Invites }).from(applications)
      .innerJoin(users, eq(users.id, applications.userId)).innerJoin(castingRoles, eq(castingRoles.id, applications.roleId))
      .leftJoin(round2Invites, eq(round2Invites.applicationId, applications.id))
      .where(where).orderBy(order).limit(limit).offset(skip);
    const counts = await db.select({ status: applications.status, n: count() }).from(applications).where(eq(applications.castingId, c.id)).groupBy(applications.status);
    res.json({
      counts: Object.fromEntries([...PIPELINE.map((s) => [s, 0]), ...counts.map((x) => [x.status, x.n])]),
      ...pageResult(rows.map((x) => applicantView(x.a, x.u, x.role, who, { round2: x.inv ? { date: x.inv.date, venue: x.inv.venue, bring: x.inv.bring } : null })), n, page, limit),
    });
  }));

  async function loadApp(c: Casting, appId: string) {
    const row = await db.select({ a: applications, u: users, role: castingRoles }).from(applications)
      .innerJoin(users, eq(users.id, applications.userId)).innerJoin(castingRoles, eq(castingRoles.id, applications.roleId))
      .where(and(eq(applications.id, appId), eq(applications.castingId, c.id))).then((x) => x[0]);
    if (!row) throw notFound('Applicant');
    return row;
  }

  /** One applicant. Opening an "Applied" applicant marks it "Viewed". */
  r.get('/:id/applicants/:appId', ah(async (req, res) => {
    const c = await load(req, req.params.id);
    let row = await loadApp(c, req.params.appId);
    if (row.a.status === 'APPLIED') {
      await db.update(applications).set({ status: 'VIEWED' }).where(eq(applications.id, row.a.id));
      row = { ...row, a: { ...row.a, status: 'VIEWED' } };
    }
    const media = await db.select().from(schema.media).where(eq(schema.media.userId, row.u.id)).orderBy(asc(schema.media.order));
    const notes = await db.select().from(applicationNotes).where(eq(applicationNotes.applicationId, row.a.id)).orderBy(desc(applicationNotes.createdAt));
    res.json({ applicant: applicantView(row.a, row.u, row.role, who), media, notes: who === 'admin' ? notes : notes.filter((n) => !n.byAdmin) });
  }));

  const patchBody = z.object({ status: z.enum(PIPELINE).optional(), rating: z.coerce.number().int().min(0).max(5).optional() });

  r.patch('/:id/applicants/:appId', ah(async (req, res) => {
    const c = await load(req, req.params.id);
    const body = parse(patchBody, req.body);
    const row = await loadApp(c, req.params.appId);
    if (body.rating !== undefined) await db.update(applications).set({ rating: body.rating }).where(eq(applications.id, row.a.id));
    if (body.status) {
      if (body.status === 'ROUND2') throw badRequest('Use “Invite to round 2” so the talent gets the date and venue');
      await setStatus([row.a.id], body.status);
      if (who === 'admin') await audit(req, 'castings', `Applicant → ${body.status}`, `${c.code} · ${row.u.code} ${row.u.name}`);
    }
    const fresh = await loadApp(c, row.a.id);
    res.json({ applicant: applicantView(fresh.a, fresh.u, fresh.role, who) });
  }));

  r.post('/:id/applicants/bulk', ah(async (req, res) => {
    const c = await load(req, req.params.id);
    const { ids, status } = parse(z.object({ ids: z.array(z.string()).min(1).max(500), status: z.enum(['VIEWED', 'SHORTLISTED', 'SELECTED', 'REJECTED']) }), req.body);
    const own = await db.select({ id: applications.id }).from(applications).where(and(eq(applications.castingId, c.id), inArray(applications.id, ids)));
    const updated = await setStatus(own.map((o) => o.id), status);
    if (who === 'admin') await audit(req, 'castings', `${own.length} applicants → ${status}`, c.code);
    res.json({ updated: updated.length });
  }));

  /** Private notes. Admin notes are never shown to member posters. */
  r.post('/:id/applicants/:appId/notes', ah(async (req, res) => {
    const c = await load(req, req.params.id);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(2000) }), req.body);
    const row = await loadApp(c, req.params.appId);
    const [note] = await db.insert(applicationNotes).values({ applicationId: row.a.id, text, byAdmin: who === 'admin', authorName: who === 'admin' ? req.admin!.name : req.user!.name }).returning();
    res.status(201).json({ note });
  }));

  /** Invite applicants to round 2 with date and venue. Sends the "Invited to round 2" message. */
  r.post('/:id/round2', ah(async (req, res) => {
    const c = await load(req, req.params.id);
    const body = parse(z.object({
      ids: z.array(z.string()).min(1).max(500),
      date: z.coerce.date().refine((d) => d > new Date(Date.now() - 86_400_000), 'Pick a future date'),
      venue: z.string().trim().min(2).max(300),
      bring: z.string().trim().max(500).default(''),
      channels: z.array(z.enum(['push', 'sms', 'whatsapp'])).default(['push']),
    }), req.body);
    const rows = await db.select({ a: applications, role: castingRoles }).from(applications).innerJoin(castingRoles, eq(castingRoles.id, applications.roleId))
      .where(and(eq(applications.castingId, c.id), inArray(applications.id, body.ids)));
    if (!rows.length) throw notFound('Applicant');
    for (const { a, role } of rows) {
      await db.insert(round2Invites).values({ applicationId: a.id, date: body.date, venue: body.venue, bring: body.bring, channels: body.channels })
        .onConflictDoUpdate({ target: round2Invites.applicationId, set: { date: body.date, venue: body.venue, bring: body.bring, channels: body.channels, sentAt: new Date() } });
      await db.update(applications).set({ status: 'ROUND2' }).where(eq(applications.id, a.id));
      await notifyRule('round2', a.userId, { role: role.name, casting: c.title, date: body.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }), venue: body.venue }, '/my-applications');
    }
    if (who === 'admin') await audit(req, 'castings', `Invited ${rows.length} to round 2`, c.code);
    res.json({ invited: rows.length });
  }));

  /** CSV for Excel. Phones are only included where the caller may see them. */
  r.get('/:id/applicants.csv', ah(async (req, res) => {
    const c = await load(req, req.params.id);
    const rows = await db.select({ a: applications, u: users, role: castingRoles }).from(applications)
      .innerJoin(users, eq(users.id, applications.userId)).innerJoin(castingRoles, eq(castingRoles.id, applications.roleId))
      .where(eq(applications.castingId, c.id)).orderBy(asc(castingRoles.name), desc(applications.rating));
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Code', 'Name', 'Role', 'Status', 'Rating', 'Gender', 'City', 'Height (cm)', 'Languages', 'Tape', 'Applied', 'Phone'];
    const lines = rows.map(({ a, u, role }) => {
      const v = applicantView(a, u, role, who);
      return [u.code, u.name, role.name, a.status, a.rating, u.gender, u.city, u.heightCm, u.languages.join(' / '), a.tapeUrl, a.createdAt.toISOString().slice(0, 10), v.phone ?? v.phoneMasked].map(esc).join(',');
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${c.code}-applicants.csv"`);
    res.send('﻿' + [head.map(esc).join(','), ...lines].join('\n'));
  }));

  return r;
}

