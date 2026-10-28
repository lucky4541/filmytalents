import { Router, type Request } from 'express';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db, schema } from '../../db';
import { ah, parse } from '../../lib/http';
import { badRequest, forbidden, notFound, unauthorized } from '../../lib/errors';
import { publicUser } from '../../lib/serialize';
import { isTest } from '../../config/env';
import { brandName } from '../../lib/brand';

const { shortlistShares, shareItems, applications, users, castings, castingRoles, clients, media } = schema;

/**
 * Public page for clients (no login): /share/:token on the app.
 * The client marks each talent Yes / Maybe / No with a comment. Phone numbers are never shown.
 */
const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: isTest ? 10_000 : 60, standardHeaders: true, legacyHeaders: false }));

async function open(req: Request) {
  const s = await db.query.shortlistShares.findFirst({ where: eq(shortlistShares.token, req.params.token.toLowerCase()) });
  if (!s) throw notFound('Shortlist');
  if (s.revokedAt) throw forbidden(`This link has been turned off. Ask ${await brandName()} for a new one.`);
  if (s.expiresAt < new Date()) throw forbidden(`This link has expired. Ask ${await brandName()} for a new one.`);
  if (s.passcodeHash) {
    const code = String(req.headers['x-share-passcode'] ?? req.query.passcode ?? '');
    if (!code) throw unauthorized(`Enter the passcode ${await brandName()} sent you`);
    if (!(await bcrypt.compare(code, s.passcodeHash))) throw unauthorized('Wrong passcode');
  }
  return s;
}

router.get('/:token', ah(async (req, res) => {
  const s = await open(req);
  const [c, client] = await Promise.all([
    db.query.castings.findFirst({ where: eq(castings.id, s.castingId) }),
    db.query.clients.findFirst({ where: eq(clients.id, s.clientId) }),
  ]);
  const rows = await db.select({ i: shareItems, a: applications, u: users, r: castingRoles }).from(shareItems)
    .innerJoin(applications, eq(applications.id, shareItems.applicationId)).innerJoin(users, eq(users.id, applications.userId))
    .innerJoin(castingRoles, eq(castingRoles.id, applications.roleId)).where(eq(shareItems.shareId, s.id)).orderBy(asc(castingRoles.name), asc(users.name));
  const photos = rows.length ? await db.select().from(media).where(and(inArray(media.userId, rows.map((r) => r.u.id)), s.showVideos ? undefined : eq(media.type, 'PHOTO'))).orderBy(asc(media.order)) : [];
  await db.update(shortlistShares).set({ views: sql`${shortlistShares.views} + 1`, lastViewedAt: new Date() }).where(eq(shortlistShares.id, s.id));
  res.json({
    share: { title: s.title, message: s.message, expiresAt: s.expiresAt, submittedAt: s.submittedAt, allowDownload: s.allowDownload, showVideos: s.showVideos, showMeasurements: s.showMeasurements, createdBy: s.createdByName, client: client ? { company: client.company, contactName: client.contactName } : null },
    casting: c ? { code: c.code, title: c.title, production: c.production, projectType: c.projectType, location: c.location } : null,
    talents: rows.map(({ i, a, u, r }) => {
      const p = publicUser(u);
      return {
        applicationId: a.id, role: r.name, pick: i.pick, comment: i.comment,
        talent: { code: p.code, name: p.name, gender: p.gender, age: p.age, city: p.city, languages: p.languages, crafts: p.crafts, experience: p.experience, verified: p.verified, avatarUrl: p.avatarUrl, bio: p.bio, heightCm: s.showMeasurements ? u.heightCm : null },
        tapeUrl: s.showVideos ? a.tapeUrl : null,
        media: photos.filter((m) => m.userId === u.id).slice(0, 8).map((m) => ({ type: m.type, url: m.url, caption: m.caption })),
      };
    }),
  });
}));

/** Save picks. submit=true tells the casting team the client is done (they can still change picks until the link expires). */
router.post('/:token/feedback', ah(async (req, res) => {
  const s = await open(req);
  const body = parse(z.object({
    items: z.array(z.object({ applicationId: z.string(), pick: z.enum(['yes', 'maybe', 'no']).nullable(), comment: z.string().max(1000).default('') })).max(200),
    submit: z.boolean().default(false),
  }), req.body);
  const ids = new Set((await db.select({ id: shareItems.applicationId }).from(shareItems).where(eq(shareItems.shareId, s.id))).map((x) => x.id));
  const bad = body.items.find((i) => !ids.has(i.applicationId));
  if (bad) throw badRequest('One of these talents is not in this shortlist');
  for (const i of body.items) {
    await db.update(shareItems).set({ pick: i.pick, comment: i.comment, pickedAt: new Date() }).where(and(eq(shareItems.shareId, s.id), eq(shareItems.applicationId, i.applicationId)));
  }
  if (body.submit) await db.update(shortlistShares).set({ submittedAt: new Date() }).where(eq(shortlistShares.id, s.id));
  res.json({ ok: true, saved: body.items.length, submitted: body.submit });
}));

export default router;
