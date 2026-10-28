import { Router } from 'express';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { adminUser, meUser } from '../../lib/serialize';
import { audit } from '../../lib/audit';
import { notify } from '../../lib/notify';
import { removeFile, signDocs } from '../../lib/storage';
import { requireAdmin, requirePerm } from '../../middleware/auth';
import { revokeAllFor } from '../auth/tokens';
import { brandName } from '../../lib/brand';

const { users, verificationRequests: vr, dataRequests: dr, media } = schema;

/* ============================ ID verification ============================ */
export const verification = Router();
verification.use(requireAdmin, requirePerm('verification'));

/** Queue. status: PENDING (default) | APPROVED | REJECTED | MORE_INFO | all */
verification.get('/', ah(async (req, res) => {
  const status = String(req.query.status ?? 'PENDING').toUpperCase();
  const { page, limit, skip } = paging(req.query, 100);
  const where = status === 'ALL' ? undefined : eq(vr.status, status as 'PENDING');
  const [{ n }] = await db.select({ n: count() }).from(vr).where(where);
  const rows = await db.select({ r: vr, u: users }).from(vr).innerJoin(users, eq(users.id, vr.userId)).where(where)
    .orderBy(status === 'PENDING' ? asc(vr.submittedAt) : desc(vr.submittedAt)).limit(limit).offset(skip);
  const [counts] = await db.select({
    pending: sql<number>`count(*) FILTER (WHERE ${vr.status} = 'PENDING')`.mapWith(Number),
    approved: sql<number>`count(*) FILTER (WHERE ${vr.status} = 'APPROVED')`.mapWith(Number),
    rejected: sql<number>`count(*) FILTER (WHERE ${vr.status} = 'REJECTED')`.mapWith(Number),
    moreInfo: sql<number>`count(*) FILTER (WHERE ${vr.status} = 'MORE_INFO')`.mapWith(Number),
  }).from(vr);
  res.json({ counts, ...pageResult(rows.map((x) => ({ ...signDocs(x.r), user: adminUser(x.u) })), n, page, limit) });
}));

async function loadReq(id: string) {
  const r = await db.query.verificationRequests.findFirst({ where: eq(vr.id, id) });
  if (!r) throw notFound('Verification request');
  const u = await db.query.users.findFirst({ where: eq(users.id, r.userId) });
  if (!u) throw notFound('Member');
  return { r, u };
}

verification.get('/:id', ah(async (req, res) => {
  const { r, u } = await loadReq(req.params.id);
  const history = await db.select().from(vr).where(eq(vr.userId, u.id)).orderBy(desc(vr.submittedAt));
  await audit(req, 'verification', 'Viewed ID documents', `${u.code} ${u.name}`);
  res.json({ request: signDocs(r), user: adminUser(u), history: history.map(signDocs) });
}));

verification.post('/:id/approve', ah(async (req, res) => {
  const { r, u } = await loadReq(req.params.id);
  if (r.status === 'APPROVED') throw badRequest('Already approved');
  const [request] = await db.update(vr).set({ status: 'APPROVED', reason: '', reviewedBy: req.admin!.name, reviewedAt: new Date() }).where(eq(vr.id, r.id)).returning();
  await db.update(users).set({ verified: true }).where(eq(users.id, u.id));
  await notify(u.id, 'verification', 'You’re verified ✓', 'Your profile now shows the verified badge.', '/verify');
  await audit(req, 'verification', 'Approved ID verification', `${u.code} ${u.name}`);
  res.json({ request });
}));

const reasonBody = z.object({ reason: z.string().trim().min(3, 'Tell the member what went wrong').max(500) });

verification.post('/:id/reject', ah(async (req, res) => {
  const { r, u } = await loadReq(req.params.id);
  const { reason } = parse(reasonBody, req.body);
  const [request] = await db.update(vr).set({ status: 'REJECTED', reason, reviewedBy: req.admin!.name, reviewedAt: new Date() }).where(eq(vr.id, r.id)).returning();
  await notify(u.id, 'verification', 'Verification not approved', `${reason}. You can upload your documents again.`, '/verify');
  await audit(req, 'verification', `Rejected ID verification: ${reason}`, `${u.code} ${u.name}`);
  res.json({ request });
}));

verification.post('/:id/more-info', ah(async (req, res) => {
  const { r, u } = await loadReq(req.params.id);
  const { reason } = parse(reasonBody, req.body);
  const [request] = await db.update(vr).set({ status: 'MORE_INFO', reason, reviewedBy: req.admin!.name, reviewedAt: new Date() }).where(eq(vr.id, r.id)).returning();
  await notify(u.id, 'verification', 'We need one more thing', reason, '/verify');
  await audit(req, 'verification', `Asked for more info: ${reason}`, `${u.code} ${u.name}`);
  res.json({ request });
}));

/* ============================ Data requests (DPDP) ============================ */
export const dataRequests = Router();
dataRequests.use(requireAdmin, requirePerm('users'));

const DAYS = 30;

dataRequests.get('/', ah(async (req, res) => {
  const status = String(req.query.status ?? 'pending');
  const where = status === 'all' ? undefined : eq(dr.status, status);
  const rows = await db.select({ r: dr, u: users }).from(dr).innerJoin(users, eq(users.id, dr.userId)).where(where).orderBy(asc(dr.requestedAt)).limit(500);
  res.json({
    items: rows.map((x) => ({ ...x.r, dueAt: new Date(x.r.requestedAt.getTime() + DAYS * 86_400_000), user: adminUser(x.u) })),
  });
}));

/** Everything we hold about a member, as JSON. Used to answer "export" requests. */
export const EXPORT_VALID_DAYS = 7;
export async function exportData(userId: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!u) throw notFound('Member');
  const [gallery, apps, pays, verifs, searches, views, reqs] = await Promise.all([
    db.select().from(media).where(eq(media.userId, userId)),
    db.select().from(schema.applications).where(eq(schema.applications.userId, userId)),
    db.select().from(schema.payments).where(eq(schema.payments.userId, userId)),
    db.select().from(vr).where(eq(vr.userId, userId)),
    db.select().from(schema.savedSearches).where(eq(schema.savedSearches.userId, userId)),
    db.select({ n: count() }).from(schema.profileViews).where(eq(schema.profileViews.viewedId, userId)),
    db.select().from(dr).where(eq(dr.userId, userId)),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    account: meUser(u),
    gallery: gallery.map((m) => ({ type: m.type, url: m.url, caption: m.caption, at: m.createdAt })),
    applications: apps.map((a) => ({ castingId: a.castingId, status: a.status, at: a.createdAt })),
    payments: pays.map((p) => ({ invoice: p.invoiceNo, amountPaise: p.amount, status: p.status, at: p.createdAt })),
    verification: verifs.map((v) => ({ docType: v.docType, status: v.status, at: v.submittedAt })),
    savedSearches: searches.map((s) => ({ label: s.label, query: s.query })),
    profileViews: views[0].n,
    dataRequests: reqs.map((r) => ({ type: r.type, status: r.status, at: r.requestedAt })),
  };
}

dataRequests.get('/:id/export', ah(async (req, res) => {
  const r = await db.query.dataRequests.findFirst({ where: eq(dr.id, req.params.id) });
  if (!r) throw notFound('Request');
  const data = await exportData(r.userId);
  await audit(req, 'users', 'Downloaded member data export', data.account.code);
  res.setHeader('Content-Disposition', `attachment; filename="casting-hub-${data.account.code}.json"`);
  res.json(data);
}));

/** Removes a member's personal data but keeps payment rows (needed for GST records). */
export async function anonymizeUser(userId: string) {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!u) return;
  const files = await db.select({ url: media.url }).from(media).where(eq(media.userId, userId));
  const docs = await db.select({ docs: vr.docs }).from(vr).where(eq(vr.userId, userId));
  await db.transaction(async (tx) => {
    await tx.delete(media).where(eq(media.userId, userId));
    await tx.delete(vr).where(eq(vr.userId, userId));
    await tx.delete(schema.follows).where(sql`${schema.follows.followerId} = ${userId} OR ${schema.follows.followingId} = ${userId}`);
    await tx.delete(schema.savedSearches).where(eq(schema.savedSearches.userId, userId));
    await tx.update(users).set({
      status: 'DELETED', name: 'Deleted member', phone: `deleted:${userId}`, email: null, passwordHash: null, passwordSetAt: null, bio: '', dob: null, city: null, state: null,
      crafts: [], languages: [], skills: [], avatarUrl: null, coverUrl: null, instagram: null, youtube: null,
      guardianName: null, guardianRelation: null, guardianPhone: null, prefs: {}, privacy: { hideFromSearch: true },
    }).where(eq(users.id, userId));
  });
  await revokeAllFor('member', userId);
  for (const f of [...files.map((x) => x.url), ...docs.flatMap((d) => d.docs.map((x) => x.url)), u.avatarUrl, u.coverUrl]) await removeFile(f);
}

/** Mark done. For "delete" this permanently removes the member's personal data. */
dataRequests.post('/:id/complete', ah(async (req, res) => {
  const r = await db.query.dataRequests.findFirst({ where: eq(dr.id, req.params.id) });
  if (!r) throw notFound('Request');
  if (r.status !== 'pending') throw badRequest('This request is already closed');
  const u = await db.query.users.findFirst({ where: eq(users.id, r.userId), columns: { code: true, name: true } });
  if (r.type === 'delete') await anonymizeUser(r.userId);
  else await notify(r.userId, 'data', 'Your data is ready to download', `Your ${await brandName()} data request was approved. Download it from Settings → Your data within ${EXPORT_VALID_DAYS} days.`, '/settings#data');
  const [item] = await db.update(dr).set({ status: 'done', handledBy: req.admin!.name, handledAt: new Date() }).where(eq(dr.id, r.id)).returning();
  await audit(req, 'users', r.type === 'delete' ? 'Deleted member account and data' : 'Approved data download', `${u?.code} ${u?.name}`);
  res.json({ item });
}));

dataRequests.post('/:id/decline', ah(async (req, res) => {
  const { reason } = parse(reasonBody, req.body);
  const [item] = await db.update(dr).set({ status: 'declined', handledBy: req.admin!.name, handledAt: new Date() }).where(and(eq(dr.id, req.params.id), eq(dr.status, 'pending'))).returning();
  if (!item) throw notFound('Request');
  if (item.type === 'delete') await db.update(users).set({ deletionRequestedAt: null }).where(eq(users.id, item.userId));
  await notify(item.userId, 'data', 'About your data request', reason);
  await audit(req, 'users', `Declined ${item.type} request: ${reason}`, item.userId);
  res.json({ item });
}));

