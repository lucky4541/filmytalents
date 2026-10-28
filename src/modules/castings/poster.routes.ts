import { Router, type Request } from 'express';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import type { Casting } from '../../db/schema';
import { ah, parse } from '../../lib/http';
import { badRequest, forbidden, notFound, paymentRequired } from '../../lib/errors';
import { nextCastingCode } from '../../lib/codes';
import { getSetting } from '../../lib/settings';
import { planAllows, requireFeature, requireMember } from '../../middleware/auth';
import { applicantCounts, assertSafeCasting, castingInput, rolesFor, saveRoles } from './service';
import { pipelineRoutes } from './pipeline';
import { scheduleRoutes } from './schedule';

const { castings, castingRoles } = schema;

/**
 * Pro members post their own castings and pick their own applicants.
 * Every new or edited casting goes to the admin approval queue (PENDING) before it is live.
 */
const router = Router();
router.use(requireMember);

async function featureOn(_req: Request) {
  const f = await getSetting<{ memberCastings?: boolean }>('features', {});
  if (f.memberCastings === false) throw forbidden('Posting castings is paused right now. Please try again later.');
}

async function own(req: Request, id: string): Promise<Casting> {
  const c = await db.query.castings.findFirst({ where: and(eq(castings.id, id), eq(castings.postedByUserId, req.user!.id)) });
  if (!c) throw notFound('Casting');
  return c;
}

export function mineView(c: Casting, roles: typeof castingRoles.$inferSelect[], counts?: Record<string, number>) {
  return {
    id: c.id, code: c.code, title: c.title, production: c.production, showProductionAs: c.showProductionAs, projectType: c.projectType, posterUrl: c.posterUrl,
    description: c.description, location: c.location, mode: c.mode, venue: c.venue, languages: c.languages, budget: c.budget, deadline: c.deadline,
    status: c.status, reviewNote: c.reviewNote, publishedAt: c.publishedAt, views: c.views, createdAt: c.createdAt, updatedAt: c.updatedAt,
    roles, applicants: counts ?? { total: 0 },
  };
}

router.get('/', ah(async (req, res) => {
  const rows = await db.select().from(castings).where(eq(castings.postedByUserId, req.user!.id)).orderBy(desc(castings.createdAt));
  const ids = rows.map((r) => r.id);
  const [roles, counts] = await Promise.all([rolesFor(ids), applicantCounts(ids)]);
  res.json({ items: rows.map((c) => mineView(c, roles.get(c.id) ?? [], counts.get(c.id))) });
}));

router.post('/', requireFeature('postCastings', 'Posting castings'), ah(async (req, res) => {
  await featureOn(req);
  const body = parse(castingInput, req.body);
  if (body.deadline <= new Date()) throw badRequest('The last date must be in the future');
  await assertSafeCasting(body, true);
  const [{ n }] = await db.select({ n: count() }).from(castings).where(and(eq(castings.postedByUserId, req.user!.id), inArray(castings.status, ['PENDING', 'CHANGES', 'LIVE'])));
  if (n >= 10) throw badRequest('You can have up to 10 open castings. Close one to post another.');
  const { roles, ...data } = body;
  const [c] = await db.insert(castings).values({ ...data, code: await nextCastingCode('MC'), status: 'PENDING', visibility: 'ALL', postedByUserId: req.user!.id }).returning();
  try { await saveRoles(c.id, roles); } catch (e) { await db.delete(castings).where(eq(castings.id, c.id)); throw e; }
  const r = await db.select().from(castingRoles).where(eq(castingRoles.castingId, c.id));
  res.status(201).json({ casting: mineView(c, r), message: 'Sent for review. Our team checks every casting, usually within a few hours.' });
}));

router.get('/:id', ah(async (req, res) => {
  const c = await own(req, req.params.id);
  const [roles, counts] = await Promise.all([rolesFor([c.id]), applicantCounts([c.id])]);
  res.json({ casting: mineView(c, roles.get(c.id) ?? [], counts.get(c.id)) });
}));

/**
 * Edit. Pending / changes-requested / rejected castings go back to review.
 * A live casting can only change its last date, venue and number of positions without a new review.
 */
router.patch('/:id', requireFeature('postCastings', 'Editing castings'), ah(async (req, res) => {
  const c = await own(req, req.params.id);
  if (['CLOSED', 'ARCHIVED'].includes(c.status)) throw badRequest('This casting is closed');
  if (c.status === 'LIVE') {
    const body = parse(z.object({
      deadline: z.coerce.date().optional(), venue: z.string().trim().max(200).optional(),
      positions: z.array(z.object({ roleId: z.string(), positions: z.coerce.number().int().min(1).max(500) })).optional(),
    }).strict('A live casting can only change its last date, venue and positions. Close it and post again for bigger changes.'), req.body);
    if (body.deadline && body.deadline <= new Date()) throw badRequest('The last date must be in the future');
    await db.update(castings).set({ ...(body.deadline ? { deadline: body.deadline } : {}), ...(body.venue !== undefined ? { venue: body.venue } : {}) }).where(eq(castings.id, c.id));
    for (const p of body.positions ?? []) await db.update(castingRoles).set({ positions: p.positions }).where(and(eq(castingRoles.id, p.roleId), eq(castingRoles.castingId, c.id)));
  } else {
    const body = parse(castingInput, req.body);
    if (body.deadline <= new Date()) throw badRequest('The last date must be in the future');
    await assertSafeCasting(body, true);
    const { roles, ...data } = body;
    await db.update(castings).set({ ...data, status: 'PENDING', reviewNote: '' }).where(eq(castings.id, c.id));
    await saveRoles(c.id, roles);
  }
  const fresh = await own(req, c.id);
  const [roles, counts] = await Promise.all([rolesFor([c.id]), applicantCounts([c.id])]);
  res.json({ casting: mineView(fresh, roles.get(c.id) ?? [], counts.get(c.id)) });
}));

router.post('/:id/close', ah(async (req, res) => {
  const c = await own(req, req.params.id);
  const [row] = await db.update(castings).set({ status: 'CLOSED' }).where(eq(castings.id, c.id)).returning();
  res.json({ casting: mineView(row, (await rolesFor([c.id])).get(c.id) ?? []) });
}));

/** Withdraw a casting that never went live. */
router.delete('/:id', ah(async (req, res) => {
  const c = await own(req, req.params.id);
  if (!['PENDING', 'CHANGES', 'REJECTED'].includes(c.status)) throw badRequest('Live castings can be closed, not deleted');
  await db.delete(castings).where(eq(castings.id, c.id));
  res.json({ ok: true });
}));

// Applicants: shortlist, round 2, select (reveals phone), reject, notes, CSV.
router.use('/', pipelineRoutes('poster', async (req, id) => {
  const c = await own(req, id);
  if (!['LIVE', 'CLOSED'].includes(c.status)) throw badRequest('Applicants appear once the casting is approved and live');
  return c;
}));

// Audition days & time slots for their own live castings (Pro feature, same rules as the admin team).
router.use('/', scheduleRoutes('poster', async (req, id) => {
  const c = await own(req, id);
  if (!['LIVE', 'CLOSED'].includes(c.status)) throw badRequest('You can schedule auditions once the casting is approved and live');
  return c;
}, async (req) => {
  if (!(await planAllows(req.user!, 'postCastings'))) throw paymentRequired('Audition scheduling is part of Pro. Upgrade to schedule time slots.');
}));

export default router;
