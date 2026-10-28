import { Router } from 'express';
import { and, arrayOverlaps, asc, count, desc, eq, gte, ilike, isNotNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { publicUser } from '../../lib/serialize';
import { optionalMember, requireMember } from '../../middleware/auth';
import type { User } from '../../db/schema';

const { users, media, follows, blocks, profileViews } = schema;
const router = Router();

const csv = z.string().max(300).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).optional();
const searchSchema = z.object({
  q: z.string().trim().max(80).optional(),
  craft: csv, city: csv, language: csv,
  gender: z.enum(['Male', 'Female', 'Other']).optional(),
  ageMin: z.coerce.number().int().min(0).max(100).optional(),
  ageMax: z.coerce.number().int().min(0).max(100).optional(),
  heightMin: z.coerce.number().int().optional(),
  heightMax: z.coerce.number().int().optional(),
  experience: z.string().max(20).optional(),
  verified: z.enum(['true', 'false']).optional(),
  pro: z.enum(['true', 'false']).optional(),
  hasPhotos: z.enum(['true', 'false']).optional(),
  sort: z.enum(['relevant', 'new', 'active', 'views']).default('relevant'),
});

const yearsAgo = (n: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

/** Members blocked by me or who blocked me — never shown to each other. */
const notBlocked = (viewerId: string) => sql`${users.id} NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ${viewerId} UNION SELECT blocker_id FROM blocks WHERE blocked_id = ${viewerId})`;

/**
 * Home page hero: the member most recently shortlisted for an audition, plus the newest members.
 * Only adults with a photo who show in search; no casting names or other private details are shared.
 */
router.get('/showcase', ah(async (_req, res) => {
  const visible = and(eq(users.status, 'ACTIVE'), eq(users.isMinor, false), isNotNull(users.avatarUrl), ne(users.name, ''), sql`coalesce((${users.privacy}->>'hideFromSearch')::boolean, false) = false`);
  const [pick] = await db.select({ u: users }).from(schema.applications).innerJoin(users, eq(users.id, schema.applications.userId))
    .where(and(visible, sql`${schema.applications.status} IN ('SHORTLISTED','ROUND2','SELECTED')`))
    .orderBy(desc(schema.applications.updatedAt)).limit(1);
  const latest = await db.select().from(users).where(pick ? and(visible, ne(users.id, pick.u.id)) : visible).orderBy(desc(users.createdAt)).limit(2);
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ shortlisted: pick ? publicUser(pick.u) : null, latest: latest.map(publicUser) });
}));

/** Talent search. Pro members get a boost in the default "relevant" order. */
router.get('/', optionalMember, ah(async (req, res) => {
  const f = parse(searchSchema, req.query);
  const { page, limit, skip } = paging(req.query, 48);
  const where: SQL[] = [eq(users.status, 'ACTIVE'), sql`coalesce((${users.privacy}->>'hideFromSearch')::boolean, false) = false`, ne(users.name, '')];
  if (req.user) where.push(ne(users.id, req.user.id), notBlocked(req.user.id));
  if (f.q) where.push(or(ilike(users.name, `%${f.q}%`), ilike(users.code, `%${f.q}%`), ilike(users.city, `%${f.q}%`), sql`${users.skills}::text ILIKE ${'%' + f.q + '%'}`)!);
  if (f.craft?.length) where.push(arrayOverlaps(users.crafts, f.craft));
  if (f.language?.length) where.push(arrayOverlaps(users.languages, f.language));
  if (f.city?.length) where.push(or(...f.city.map((c) => ilike(users.city, c)))!);
  if (f.gender) where.push(eq(users.gender, f.gender));
  if (f.ageMin !== undefined) where.push(lte(users.dob, yearsAgo(f.ageMin)));
  if (f.ageMax !== undefined) where.push(gte(users.dob, yearsAgo(f.ageMax + 1)));
  if (f.heightMin) where.push(gte(users.heightCm, f.heightMin));
  if (f.heightMax) where.push(lte(users.heightCm, f.heightMax));
  if (f.experience) where.push(eq(users.experience, f.experience));
  if (f.verified === 'true') where.push(eq(users.verified, true));
  if (f.pro === 'true') where.push(ne(users.planId, 'free'));
  if (f.hasPhotos === 'true') where.push(isNotNull(users.avatarUrl));
  const w = and(...where);

  const proFirst = sql`CASE WHEN ${users.planId} <> 'free' AND (${users.planUntil} IS NULL OR ${users.planUntil} > now()) THEN 0 ELSE 1 END`;
  const order = f.sort === 'new' ? [desc(users.createdAt)]
    : f.sort === 'active' ? [desc(users.lastActiveAt)]
    : f.sort === 'views' ? [desc(users.profileViews)]
    : [asc(proFirst), desc(users.verified), sql`(${users.avatarUrl} IS NULL)`, desc(users.lastActiveAt)];

  const [{ n }] = await db.select({ n: count() }).from(users).where(w);
  const rows = await db.select().from(users).where(w).orderBy(...order).limit(limit).offset(skip);
  res.json(pageResult(rows.map(publicUser), n, page, limit));
}));

async function byCode(code: string, viewer?: User) {
  const u = await db.query.users.findFirst({ where: eq(users.code, code.toUpperCase()) });
  if (!u || u.status === 'DELETED' || u.status === 'BANNED') throw notFound('Profile');
  if (viewer && viewer.id !== u.id) {
    const b = await db.query.blocks.findFirst({ where: or(and(eq(blocks.blockerId, viewer.id), eq(blocks.blockedId, u.id)), and(eq(blocks.blockerId, u.id), eq(blocks.blockedId, viewer.id))) });
    if (b && b.blockerId === u.id) throw notFound('Profile');
    return { u, blockedByMe: !!b };
  }
  return { u, blockedByMe: false };
}

/** A member's public profile. Records a profile view (once per viewer per day). */
router.get('/:code', optionalMember, ah(async (req, res) => {
  const { u, blockedByMe } = await byCode(req.params.code, req.user);
  const self = req.user?.id === u.id;
  const [gallery, [fs], [fg], following] = await Promise.all([
    db.select().from(media).where(eq(media.userId, u.id)).orderBy(asc(media.order), desc(media.createdAt)),
    db.select({ n: count() }).from(follows).where(eq(follows.followingId, u.id)),
    db.select({ n: count() }).from(follows).where(eq(follows.followerId, u.id)),
    req.user && !self ? db.query.follows.findFirst({ where: and(eq(follows.followerId, req.user.id), eq(follows.followingId, u.id)) }) : Promise.resolve(undefined),
  ]);
  if (!self) {
    const since = new Date(Date.now() - 86_400_000);
    const seen = req.user ? await db.query.profileViews.findFirst({ where: and(eq(profileViews.viewedId, u.id), eq(profileViews.viewerId, req.user.id), gte(profileViews.createdAt, since)) }) : undefined;
    if (!seen) {
      await db.insert(profileViews).values({ viewedId: u.id, viewerId: req.user?.id ?? null });
      await db.update(users).set({ profileViews: sql`${users.profileViews} + 1` }).where(eq(users.id, u.id));
    }
  }
  res.json({
    user: publicUser(u),
    media: gallery.map((m) => ({ id: m.id, type: m.type, url: m.url, thumbUrl: m.thumbUrl, caption: m.caption })),
    followers: fs.n, following: fg.n,
    isFollowing: !!following, blockedByMe, isSelf: self,
    canMessage: (u.privacy as Record<string, boolean>).allowMessages !== false && !u.isMinor,
  });
}));

router.post('/:code/follow', requireMember, ah(async (req, res) => {
  const { u, blockedByMe } = await byCode(req.params.code, req.user);
  if (u.id === req.user!.id) throw badRequest('You can’t follow yourself');
  if (blockedByMe) throw badRequest('Unblock this member first');
  await db.insert(follows).values({ followerId: req.user!.id, followingId: u.id }).onConflictDoNothing();
  res.json({ following: true });
}));

router.delete('/:code/follow', requireMember, ah(async (req, res) => {
  const { u } = await byCode(req.params.code, req.user);
  await db.delete(follows).where(and(eq(follows.followerId, req.user!.id), eq(follows.followingId, u.id)));
  res.json({ following: false });
}));

async function followList(userId: string, dir: 'followers' | 'following', q: Record<string, unknown>) {
  const { page, limit, skip } = paging(q, 50);
  const mine = dir === 'followers' ? follows.followingId : follows.followerId;
  const other = dir === 'followers' ? follows.followerId : follows.followingId;
  const where = and(eq(mine, userId), eq(users.status, 'ACTIVE'));
  const [{ n }] = await db.select({ n: count() }).from(follows).innerJoin(users, eq(users.id, other)).where(where);
  const rows = await db.select({ u: users }).from(follows).innerJoin(users, eq(users.id, other)).where(where).orderBy(desc(follows.createdAt)).limit(limit).offset(skip);
  return pageResult(rows.map((r) => publicUser(r.u)), n, page, limit);
}

router.get('/:code/followers', optionalMember, ah(async (req, res) => {
  const { u } = await byCode(req.params.code, req.user);
  res.json(await followList(u.id, 'followers', req.query));
}));

router.get('/:code/following', optionalMember, ah(async (req, res) => {
  const { u } = await byCode(req.params.code, req.user);
  res.json(await followList(u.id, 'following', req.query));
}));

/** Block: they can't see you, message you or follow you. Removes follows both ways. */
router.post('/:code/block', requireMember, ah(async (req, res) => {
  const { u } = await byCode(req.params.code, req.user);
  if (u.id === req.user!.id) throw badRequest('You can’t block yourself');
  await db.transaction(async (tx) => {
    await tx.insert(blocks).values({ blockerId: req.user!.id, blockedId: u.id }).onConflictDoNothing();
    await tx.delete(follows).where(or(and(eq(follows.followerId, req.user!.id), eq(follows.followingId, u.id)), and(eq(follows.followerId, u.id), eq(follows.followingId, req.user!.id))));
  });
  res.json({ blocked: true });
}));

router.delete('/:code/block', requireMember, ah(async (req, res) => {
  const u = await db.query.users.findFirst({ where: eq(users.code, req.params.code.toUpperCase()), columns: { id: true } });
  if (!u) throw notFound('Profile');
  await db.delete(blocks).where(and(eq(blocks.blockerId, req.user!.id), eq(blocks.blockedId, u.id)));
  res.json({ blocked: false });
}));

export default router;
