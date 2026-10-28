import { Router } from 'express';
import { and, asc, count, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound, paymentRequired } from '../../lib/errors';
import { meUser, publicUser, ageFrom } from '../../lib/serialize';
import { removeFile, runUpload, saveFile, signDocs, uploader } from '../../lib/storage';
import { env } from '../../config/env';
import { planAllows, requireMember } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import { sendOtp, verifyOtp } from '../auth/otp';
import { revokeAllFor } from '../auth/tokens';
import { PREF_KEYS, PRIVACY_KEYS, flagsSchema, phoneField, profileSchema } from './validators';
import { brandName } from '../../lib/brand';
import { EXPORT_VALID_DAYS, exportData } from './review.routes';

const { users, media, savedSearches, blocks, profileViews, verificationRequests, dataRequests } = schema;
const router = Router();
router.use(requireMember);

const MAX_PHOTOS = 30;
const MAX_VIDEOS = 10;

/* ---------------------------- Profile ---------------------------- */

router.get('/', ah(async (req, res) => {
  const [followers] = await db.select({ n: count() }).from(schema.follows).where(eq(schema.follows.followingId, req.user!.id));
  const [following] = await db.select({ n: count() }).from(schema.follows).where(eq(schema.follows.followerId, req.user!.id));
  res.json({ user: meUser(req.user!), followers: followers.n, following: following.n });
}));

router.patch('/', ah(async (req, res) => {
  const body = parse(profileSchema, req.body);
  const u = req.user!;
  const patch: Partial<typeof users.$inferInsert> = {};
  for (const k of ['name', 'gender', 'dob', 'city', 'state', 'bio', 'crafts', 'languages', 'skills', 'experience', 'heightCm', 'guardianName', 'guardianRelation', 'guardianPhone'] as const) {
    if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
  }
  if (body.email !== undefined) patch.email = body.email || null;
  if (body.instagram !== undefined) patch.instagram = body.instagram || null;
  if (body.youtube !== undefined) patch.youtube = body.youtube || null;

  // Under 18 → a parent or guardian must be named and give consent.
  const dob = body.dob !== undefined ? body.dob : u.dob;
  const minor = !!dob && ageFrom(dob) < 18;
  patch.isMinor = minor;
  if (minor) {
    const g = { name: patch.guardianName ?? u.guardianName, relation: patch.guardianRelation ?? u.guardianRelation, phone: patch.guardianPhone ?? u.guardianPhone };
    if (!g.name || !g.relation || !g.phone) throw badRequest('Members under 18 need a parent or guardian’s name, relation and phone number');
    if (g.phone === u.phone) throw badRequest('Guardian phone must be different from your own number');
    if (body.guardianConsent) patch.guardianConsentAt = new Date();
    else if (!u.guardianConsentAt) throw badRequest('Your parent or guardian must agree to the terms (guardianConsent: true)');
  }
  const [user] = await db.update(users).set(patch).where(eq(users.id, u.id)).returning();
  res.json({ user: meUser(user) });
}));

router.patch('/prefs', ah(async (req, res) => {
  const body = parse(flagsSchema(PREF_KEYS), req.body);
  const [user] = await db.update(users).set({ prefs: { ...req.user!.prefs, ...body } }).where(eq(users.id, req.user!.id)).returning();
  res.json({ prefs: user.prefs });
}));

router.patch('/privacy', ah(async (req, res) => {
  const body = parse(flagsSchema(PRIVACY_KEYS), req.body);
  const [user] = await db.update(users).set({ privacy: { ...req.user!.privacy, ...body } }).where(eq(users.id, req.user!.id)).returning();
  res.json({ privacy: user.privacy });
}));

/** Profile photo or cover. Form field name: "file". */
router.post('/avatar', ah(async (req, res) => {
  await runUpload(uploader('photo').single('file'), req, res);
  const url = await saveFile(req.file, 'photo', `avatars/${req.user!.id}`);
  await removeFile(req.user!.avatarUrl);
  const [user] = await db.update(users).set({ avatarUrl: url }).where(eq(users.id, req.user!.id)).returning();
  res.json({ avatarUrl: user.avatarUrl });
}));

router.post('/cover', ah(async (req, res) => {
  await runUpload(uploader('photo').single('file'), req, res);
  const url = await saveFile(req.file, 'photo', `covers/${req.user!.id}`);
  await removeFile(req.user!.coverUrl);
  const [user] = await db.update(users).set({ coverUrl: url }).where(eq(users.id, req.user!.id)).returning();
  res.json({ coverUrl: user.coverUrl });
}));

/* ---------------------------- Change phone ---------------------------- */

router.post('/phone/send', authLimiter, ah(async (req, res) => {
  const { phone } = parse(z.object({ phone: phoneField }), req.body);
  if (phone === req.user!.phone) throw badRequest('This is already your number');
  const taken = await db.query.users.findFirst({ where: eq(users.phone, phone), columns: { id: true } });
  if (taken) throw conflict('Another account already uses this number');
  res.json({ ...(await sendOtp(phone, 'CHANGE_PHONE', req.ip)), phone });
}));

router.post('/phone/verify', authLimiter, ah(async (req, res) => {
  const { phone, code } = parse(z.object({ phone: phoneField, code: z.string().regex(/^\d{4,6}$/) }), req.body);
  await verifyOtp(phone, code, 'CHANGE_PHONE');
  const [user] = await db.update(users).set({ phone, phoneVerifiedAt: new Date() }).where(eq(users.id, req.user!.id)).returning();
  res.json({ user: meUser(user) });
}));

/* ---------------------------- Gallery ---------------------------- */

router.get('/media', ah(async (req, res) => {
  const items = await db.select().from(media).where(eq(media.userId, req.user!.id)).orderBy(asc(media.order), desc(media.createdAt));
  res.json({ items });
}));

/** Upload a photo (field "file", optional "caption"). Videos need Pro: POST /media/video. */
router.post('/media/photo', ah(async (req, res) => {
  await runUpload(uploader('photo').single('file'), req, res);
  const [{ n }] = await db.select({ n: count() }).from(media).where(and(eq(media.userId, req.user!.id), eq(media.type, 'PHOTO')));
  if (n >= MAX_PHOTOS) throw badRequest(`You can keep up to ${MAX_PHOTOS} photos. Delete one to add more.`);
  const url = await saveFile(req.file, 'photo', `media/${req.user!.id}`);
  const caption = String(req.body?.caption ?? '').slice(0, 200);
  const [item] = await db.insert(media).values({ userId: req.user!.id, type: 'PHOTO', url, caption, order: n }).returning();
  res.status(201).json({ item });
}));

router.post('/media/video', ah(async (req, res) => {
  if (!(await planAllows(req.user!, 'videoPosts'))) throw paymentRequired('Videos and showreels aren’t included in your plan. Upgrade to continue.');
  await runUpload(uploader('video').single('file'), req, res);
  const [{ n }] = await db.select({ n: count() }).from(media).where(and(eq(media.userId, req.user!.id), eq(media.type, 'VIDEO')));
  if (n >= MAX_VIDEOS) throw badRequest(`You can keep up to ${MAX_VIDEOS} videos. Delete one to add more.`);
  const url = await saveFile(req.file, 'video', `media/${req.user!.id}`);
  const caption = String(req.body?.caption ?? '').slice(0, 200);
  const [item] = await db.insert(media).values({ userId: req.user!.id, type: 'VIDEO', url, caption, order: n }).returning();
  res.status(201).json({ item });
}));

router.patch('/media/:id', ah(async (req, res) => {
  const { caption } = parse(z.object({ caption: z.string().max(200) }), req.body);
  const [item] = await db.update(media).set({ caption }).where(and(eq(media.id, req.params.id), eq(media.userId, req.user!.id))).returning();
  if (!item) throw notFound('Photo');
  res.json({ item });
}));

/** Body: { ids: [...] } in the new order. */
router.put('/media/order', ah(async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string()).max(100) }), req.body);
  await db.transaction(async (tx) => {
    for (const [i, mid] of ids.entries()) await tx.update(media).set({ order: i }).where(and(eq(media.id, mid), eq(media.userId, req.user!.id)));
  });
  res.json({ ok: true });
}));

router.delete('/media/:id', ah(async (req, res) => {
  const [item] = await db.delete(media).where(and(eq(media.id, req.params.id), eq(media.userId, req.user!.id))).returning();
  if (!item) throw notFound('Photo');
  await removeFile(item.url);
  await removeFile(item.thumbUrl);
  res.json({ ok: true });
}));

/* ---------------------------- Who viewed me ---------------------------- */

router.get('/views', ah(async (req, res) => {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const where = and(eq(profileViews.viewedId, req.user!.id), gte(profileViews.createdAt, since));
  const [{ n }] = await db.select({ n: count() }).from(profileViews).where(where);
  if (!(await planAllows(req.user!, 'whoViewed'))) return res.json({ last30Days: n, allTime: req.user!.profileViews, locked: true, items: [] });
  const { page, limit, skip } = paging(req.query, 50);
  const rows = await db.select({ v: profileViews, viewer: users }).from(profileViews).leftJoin(users, eq(users.id, profileViews.viewerId)).where(where).orderBy(desc(profileViews.createdAt)).limit(limit).offset(skip);
  const team = `${await brandName()} team`;
  const items = rows.map((r) => ({
    id: r.v.id, at: r.v.createdAt,
    viewer: r.v.byAdmin ? { kind: 'casting-team', name: team } : r.viewer ? { kind: 'member', ...publicUser(r.viewer) } : { kind: 'visitor', name: 'A visitor' },
  }));
  res.json({ last30Days: n, allTime: req.user!.profileViews, locked: false, ...pageResult(items, n, page, limit) });
}));

/* ---------------------------- Saved searches ---------------------------- */

router.get('/saved-searches', ah(async (req, res) => {
  res.json({ items: await db.select().from(savedSearches).where(eq(savedSearches.userId, req.user!.id)).orderBy(desc(savedSearches.createdAt)) });
}));

router.post('/saved-searches', ah(async (req, res) => {
  const body = parse(z.object({ label: z.string().trim().min(1).max(80), query: z.string().max(500), alerts: z.boolean().default(true) }), req.body);
  const [{ n }] = await db.select({ n: count() }).from(savedSearches).where(eq(savedSearches.userId, req.user!.id));
  if (n >= 10) throw badRequest('You can save up to 10 searches');
  const [item] = await db.insert(savedSearches).values({ ...body, userId: req.user!.id }).returning();
  res.status(201).json({ item });
}));

router.patch('/saved-searches/:id', ah(async (req, res) => {
  const body = parse(z.object({ label: z.string().trim().min(1).max(80), alerts: z.boolean() }).partial(), req.body);
  const [item] = await db.update(savedSearches).set(body).where(and(eq(savedSearches.id, req.params.id), eq(savedSearches.userId, req.user!.id))).returning();
  if (!item) throw notFound('Saved search');
  res.json({ item });
}));

router.delete('/saved-searches/:id', ah(async (req, res) => {
  await db.delete(savedSearches).where(and(eq(savedSearches.id, req.params.id), eq(savedSearches.userId, req.user!.id)));
  res.json({ ok: true });
}));

/* ---------------------------- Blocked members ---------------------------- */

router.get('/blocks', ah(async (req, res) => {
  const rows = await db.select({ at: blocks.createdAt, u: users }).from(blocks).innerJoin(users, eq(users.id, blocks.blockedId)).where(eq(blocks.blockerId, req.user!.id)).orderBy(desc(blocks.createdAt));
  res.json({ items: rows.map((r) => ({ blockedAt: r.at, user: publicUser(r.u) })) });
}));

/* ---------------------------- Referrals ---------------------------- */

router.get('/referrals', ah(async (req, res) => {
  const rows = await db.select().from(users).where(eq(users.referredById, req.user!.id)).orderBy(desc(users.createdAt)).limit(100);
  res.json({
    code: req.user!.referralCode,
    link: `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/join?ref=${req.user!.referralCode}`,
    joined: rows.length,
    upgraded: rows.filter((r) => r.planId !== 'free').length,
    bonusDays: req.user!.bonusDays,
    items: rows.map((r) => ({ name: r.name || 'New member', joinedAt: r.createdAt, isPro: r.planId !== 'free' })),
  });
}));

/* ---------------------------- Verification ---------------------------- */

router.get('/verification', ah(async (req, res) => {
  const latest = await db.query.verificationRequests.findFirst({ where: eq(verificationRequests.userId, req.user!.id), orderBy: desc(verificationRequests.submittedAt) });
  res.json({ verified: req.user!.verified, request: latest ? signDocs(latest) : null });
}));

/**
 * Multipart form. Fields: docType (Aadhaar | PAN | Passport | Driving licence | Voter ID),
 * files: idFront (required), idBack, selfie (required), guardianId (required for under-18).
 */
router.post('/verification', ah(async (req, res) => {
  const u = req.user!;
  if (u.verified) throw badRequest('Your profile is already verified');
  const pending = await db.query.verificationRequests.findFirst({ where: and(eq(verificationRequests.userId, u.id), inArray(verificationRequests.status, ['PENDING'])) });
  if (pending) throw conflict('We are already reviewing your documents. You’ll hear from us within 24 hours.');
  await runUpload(uploader('doc', 5).fields([{ name: 'idFront', maxCount: 1 }, { name: 'idBack', maxCount: 1 }, { name: 'selfie', maxCount: 1 }, { name: 'guardianId', maxCount: 1 }, { name: 'birthCert', maxCount: 1 }]), req, res);
  const { docType } = parse(z.object({ docType: z.enum(['Aadhaar', 'PAN', 'Passport', 'Driving licence', 'Voter ID']) }), req.body);
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  if (!files.idFront?.[0]) throw badRequest('Upload the front of your ID');
  if (!files.selfie?.[0]) throw badRequest('Upload a selfie');
  if (u.isMinor && !files.guardianId?.[0]) throw badRequest('Members under 18 must also upload a parent or guardian’s ID');
  const labels: Record<string, string> = { idFront: 'ID front', idBack: 'ID back', selfie: 'Selfie', guardianId: 'Guardian ID', birthCert: 'Birth certificate' };
  const docs: { label: string; url: string }[] = [];
  for (const key of Object.keys(labels)) {
    const f = files[key]?.[0];
    if (f) docs.push({ label: labels[key], url: await saveFile(f, 'doc', `kyc/${u.id}`) });
  }
  const [request] = await db.insert(verificationRequests).values({ userId: u.id, docType, docs }).returning();
  res.status(201).json({ request: signDocs(request) });
}));

/* ---------------------------- My data (DPDP) ---------------------------- */

router.get('/data-requests', ah(async (req, res) => {
  res.json({ items: await db.select().from(dataRequests).where(eq(dataRequests.userId, req.user!.id)).orderBy(desc(dataRequests.requestedAt)) });
}));

/** type "export" = send me a copy of my data; "delete" = delete my account and data. */
router.post('/data-requests', ah(async (req, res) => {
  const { type } = parse(z.object({ type: z.enum(['export', 'delete']) }), req.body);
  const open = await db.query.dataRequests.findFirst({ where: and(eq(dataRequests.userId, req.user!.id), eq(dataRequests.type, type), eq(dataRequests.status, 'pending')) });
  if (open) throw conflict(type === 'export' ? 'You already asked for your data. We’ll let you know once it’s approved.' : 'You already have a request like this. We’ll finish it within 30 days.');
  if (type === 'export') {
    const ready = await db.query.dataRequests.findFirst({ where: and(eq(dataRequests.userId, req.user!.id), eq(dataRequests.type, 'export'), eq(dataRequests.status, 'done'), gte(dataRequests.handledAt, new Date(Date.now() - EXPORT_VALID_DAYS * 86_400_000))) });
    if (ready) throw conflict('Your data is already approved. Download it from Settings → Your data.');
  }
  const [item] = await db.insert(dataRequests).values({ userId: req.user!.id, type }).returning();
  if (type === 'delete') await db.update(users).set({ deletionRequestedAt: new Date() }).where(eq(users.id, req.user!.id));
  res.status(201).json({ item });
}));

/** Download my data — only after an admin approved the request, and for EXPORT_VALID_DAYS days after. */
router.get('/data-requests/:id/download', ah(async (req, res) => {
  const r = await db.query.dataRequests.findFirst({ where: and(eq(dataRequests.id, req.params.id), eq(dataRequests.userId, req.user!.id), eq(dataRequests.type, 'export')) });
  if (!r) throw notFound('Request');
  if (r.status === 'pending') throw forbidden('Your request is waiting for approval. We’ll notify you when your data is ready.');
  if (r.status !== 'done' || !r.handledAt) throw forbidden('This request was not approved.');
  if (Date.now() - r.handledAt.getTime() > EXPORT_VALID_DAYS * 86_400_000) throw forbidden(`This download link expired after ${EXPORT_VALID_DAYS} days. Please request your data again.`);
  const data = await exportData(req.user!.id);
  res.setHeader('Content-Disposition', `attachment; filename="my-data-${data.account.code}.json"`);
  res.json(data);
}));

/** Cancel a pending delete request (logging in again also cancels it). */
router.delete('/data-requests/:id', ah(async (req, res) => {
  const [item] = await db.update(dataRequests).set({ status: 'cancelled', handledAt: new Date() })
    .where(and(eq(dataRequests.id, req.params.id), eq(dataRequests.userId, req.user!.id), eq(dataRequests.status, 'pending'))).returning();
  if (!item) throw notFound('Request');
  if (item.type === 'delete') await db.update(users).set({ deletionRequestedAt: null }).where(eq(users.id, req.user!.id));
  res.json({ item });
}));

/** Close my account: same as a delete request, plus log out everywhere. */
router.delete('/', ah(async (req, res) => {
  const open = await db.query.dataRequests.findFirst({ where: and(eq(dataRequests.userId, req.user!.id), eq(dataRequests.type, 'delete'), eq(dataRequests.status, 'pending')) });
  if (!open) await db.insert(dataRequests).values({ userId: req.user!.id, type: 'delete' });
  await db.update(users).set({ deletionRequestedAt: new Date() }).where(eq(users.id, req.user!.id));
  await revokeAllFor('member', req.user!.id);
  res.json({ ok: true, message: 'Your account will be deleted within 30 days. Log in again before then to cancel.' });
}));

export default router;
