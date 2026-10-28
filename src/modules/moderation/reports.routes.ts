import { Router } from 'express';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { notify } from '../../lib/notify';
import { adminUser, publicUser } from '../../lib/serialize';
import { removeFile } from '../../lib/storage';
import { requireAdmin, requireMember, requirePerm } from '../../middleware/auth';
import { revokeAllFor } from '../auth/tokens';
import { brandName } from '../../lib/brand';

const { reports, posts, users, castings, chatReports, messages, conversations } = schema;
const URGENT = ['Scam or fraud', 'Child safety'];
const AUTO_HIDE_AT = 3;

/* ============================ Member: report something ============================ */
export const memberReports = Router();
memberReports.use(requireMember);

memberReports.post('/', ah(async (req, res) => {
  const b = parse(z.object({ targetType: z.enum(['user', 'post', 'comment', 'casting']), targetId: z.string().min(1), reason: z.string().trim().min(3).max(80), details: z.string().trim().max(1000).default('') }), req.body);
  let label = '';
  let reportedUserId: string | null = null;
  if (b.targetType === 'user') {
    const u = await db.query.users.findFirst({ where: sql`${users.id} = ${b.targetId} OR ${users.code} = ${b.targetId.toUpperCase()}` });
    if (!u) throw notFound('Member');
    label = `${u.name} (${u.code})`; reportedUserId = u.id; b.targetId = u.id;
  } else if (b.targetType === 'casting') {
    const c = await db.query.castings.findFirst({ where: sql`${castings.id} = ${b.targetId} OR ${castings.code} = ${b.targetId.toUpperCase()}` });
    if (!c) throw notFound('Casting');
    label = `${c.code} ${c.title}`; reportedUserId = c.postedByUserId; b.targetId = c.id;
  } else {
    const p = await db.query.posts.findFirst({ where: eq(posts.id, b.targetId) });
    if (!p) throw notFound('Post');
    label = (p.text || p.type.toLowerCase()).slice(0, 80); reportedUserId = p.userId;
  }
  if (reportedUserId === req.user!.id) throw badRequest('You can’t report yourself');
  const dup = await db.query.reports.findFirst({ where: and(eq(reports.reporterId, req.user!.id), eq(reports.targetId, b.targetId), eq(reports.status, 'OPEN')) });
  if (dup) throw conflict('You already reported this. Our team is looking into it.');
  const [r] = await db.insert(reports).values({ reporterId: req.user!.id, reportedUserId, targetType: b.targetType, targetId: b.targetId, targetLabel: label, reason: b.reason, details: b.details, priority: URGENT.includes(b.reason) ? 'urgent' : 'normal' }).returning();
  if (b.targetType === 'post' || b.targetType === 'comment') {
    const [p] = await db.update(posts).set({ reportsCount: sql`${posts.reportsCount} + 1` }).where(eq(posts.id, b.targetId)).returning();
    // Several reports hide the post until a moderator looks at it.
    if (p && p.reportsCount >= AUTO_HIDE_AT && p.status === 'VISIBLE') await db.update(posts).set({ status: 'HIDDEN', flag: `Auto-hidden after ${p.reportsCount} reports` }).where(eq(posts.id, p.id));
  }
  res.status(201).json({ report: { id: r.id, status: r.status }, message: 'Thanks for telling us. Our safety team will review this, usually within 24 hours.' });
}));

/* ============================ Admin: moderation ============================ */
export const moderation = Router();
moderation.use(requireAdmin, requirePerm('moderation'));

/** Shared actions on a member: warn, suspend, ban, mute chat. */
async function actOnUser(req: Parameters<typeof audit>[0], userId: string | null, action: string, reason: string, days = 7) {
  if (!userId || action === 'none' || action === 'remove' || action === 'hide') return;
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!u) return;
  if (action === 'warn') {
    await db.update(users).set({ warnings: sql`${users.warnings} + 1` }).where(eq(users.id, u.id));
    await notify(u.id, 'warning', `A warning from ${await brandName()}`, reason);
  } else if (action === 'mute') {
    await db.update(users).set({ chatMutedUntil: new Date(Date.now() + days * 86_400_000) }).where(eq(users.id, u.id));
    await notify(u.id, 'warning', `Chat paused for ${days} days`, reason);
  } else if (action === 'suspend') {
    await db.update(users).set({ status: 'SUSPENDED', suspendedUntil: new Date(Date.now() + days * 86_400_000) }).where(eq(users.id, u.id));
    await revokeAllFor('member', u.id);
  } else if (action === 'ban') {
    await db.update(users).set({ status: 'BANNED' }).where(eq(users.id, u.id));
    await revokeAllFor('member', u.id);
  }
  await audit(req, 'moderation', `${action[0].toUpperCase()}${action.slice(1)} member: ${reason}`, `${u.code} ${u.name}`);
}

moderation.get('/stats', ah(async (_req, res) => {
  const [r] = await db.select({ open: sql<number>`count(*) FILTER (WHERE ${reports.status} = 'OPEN')`.mapWith(Number), urgent: sql<number>`count(*) FILTER (WHERE ${reports.status} = 'OPEN' AND ${reports.priority} = 'urgent')`.mapWith(Number), resolved: sql<number>`count(*) FILTER (WHERE ${reports.status} = 'RESOLVED')`.mapWith(Number), dismissed: sql<number>`count(*) FILTER (WHERE ${reports.status} = 'DISMISSED')`.mapWith(Number), all: sql<number>`count(*)`.mapWith(Number) }).from(reports);
  const [c] = await db.select({ hidden: sql<number>`count(*) FILTER (WHERE ${posts.status} = 'HIDDEN')`.mapWith(Number), flagged: sql<number>`count(*) FILTER (WHERE ${posts.flag} IS NOT NULL AND ${posts.status} = 'VISIBLE' AND ${posts.reviewedBy} IS NULL)`.mapWith(Number) }).from(posts);
  const [ch] = await db.select({ open: sql<number>`count(*) FILTER (WHERE ${chatReports.status} = 'OPEN')`.mapWith(Number), resolved: sql<number>`count(*) FILTER (WHERE ${chatReports.status} = 'RESOLVED')`.mapWith(Number), dismissed: sql<number>`count(*) FILTER (WHERE ${chatReports.status} = 'DISMISSED')`.mapWith(Number) }).from(chatReports);
  const [fm] = await db.select({ n: count() }).from(messages).where(sql`${messages.flagged} IS NOT NULL AND ${messages.createdAt} > now() - interval '7 days'`);
  const [cs] = await db.select({ visible: sql<number>`count(*) FILTER (WHERE ${posts.status} = 'VISIBLE')`.mapWith(Number), removed: sql<number>`count(*) FILTER (WHERE ${posts.status} = 'REMOVED')`.mapWith(Number), reported: sql<number>`count(*) FILTER (WHERE ${posts.reportsCount} > 0 AND ${posts.status} <> 'REMOVED')`.mapWith(Number) }).from(posts);
  res.json({ reports: r, content: { ...c, ...cs }, chatReports: ch.open, chat: ch, flaggedMessages7d: fm.n });
}));

/* ---------------------------- Reports ---------------------------- */
moderation.get('/reports', ah(async (req, res) => {
  const f = parse(z.object({ status: z.string().default('OPEN'), type: z.string().optional(), priority: z.string().optional() }), req.query);
  const { page, limit, skip } = paging(req.query, 100);
  const w: SQL[] = [];
  if (f.status !== 'all') w.push(eq(reports.status, f.status.toUpperCase() as 'OPEN'));
  if (f.type) w.push(eq(reports.targetType, f.type));
  if (f.priority) w.push(eq(reports.priority, f.priority));
  const where = w.length ? and(...w) : undefined;
  const [{ n }] = await db.select({ n: count() }).from(reports).where(where);
  const rows = await db.select().from(reports).where(where).orderBy(sql`CASE ${reports.priority} WHEN 'urgent' THEN 0 ELSE 1 END`, asc(reports.createdAt)).limit(limit).offset(skip);
  const people = await db.select().from(users).where(inArray(users.id, [...new Set(rows.flatMap((r) => [r.reporterId, r.reportedUserId]).filter((x): x is string => !!x))].concat('-')));
  const others = rows.length ? await db.select({ t: reports.targetId, n: count() }).from(reports).where(inArray(reports.targetId, rows.map((r) => r.targetId))).groupBy(reports.targetId) : [];
  res.json(pageResult(rows.map((r) => ({ ...r, reporter: people.find((p) => p.id === r.reporterId) ? publicUser(people.find((p) => p.id === r.reporterId)!) : null, reported: people.find((p) => p.id === r.reportedUserId) ? adminUser(people.find((p) => p.id === r.reportedUserId)!) : null, timesReported: others.find((o) => o.t === r.targetId)?.n ?? 1 })), n, page, limit));
}));

moderation.get('/reports/:id', ah(async (req, res) => {
  const r = await db.query.reports.findFirst({ where: eq(reports.id, req.params.id) });
  if (!r) throw notFound('Report');
  const target = r.targetType === 'casting' ? await db.query.castings.findFirst({ where: eq(castings.id, r.targetId) })
    : r.targetType === 'user' ? (await db.query.users.findFirst({ where: eq(users.id, r.targetId) }).then((u) => (u ? adminUser(u) : null)))
    : await db.query.posts.findFirst({ where: eq(posts.id, r.targetId) });
  const history = r.reportedUserId ? await db.select().from(reports).where(eq(reports.reportedUserId, r.reportedUserId)).orderBy(desc(reports.createdAt)).limit(20) : [];
  res.json({ report: r, target, history });
}));

/**
 * Resolve: action none | warn | remove (the post/casting) | suspend | ban.
 * Resolving one report closes every open report on the same item.
 */
moderation.post('/reports/:id/resolve', ah(async (req, res) => {
  const r = await db.query.reports.findFirst({ where: eq(reports.id, req.params.id) });
  if (!r) throw notFound('Report');
  const b = parse(z.object({ action: z.enum(['none', 'warn', 'remove', 'mute', 'suspend', 'ban']), note: z.string().trim().min(3, 'Add a short note').max(500), days: z.coerce.number().int().min(1).max(365).default(7), dismiss: z.boolean().default(false), removeContent: z.boolean().default(false) }), req.body);
  if (b.action === 'remove' || (b.removeContent && b.action !== 'none' && r.targetType !== 'user')) {
    if (r.targetType === 'casting') await db.update(castings).set({ status: 'ARCHIVED', reviewNote: `Removed after report: ${b.note}` }).where(eq(castings.id, r.targetId));
    else if (r.targetType === 'post' || r.targetType === 'comment') await db.update(posts).set({ status: 'REMOVED', removeReason: b.note, reviewedBy: req.admin!.name }).where(eq(posts.id, r.targetId));
    else throw badRequest('Use suspend or ban for member reports');
    if (r.reportedUserId) await notify(r.reportedUserId, 'moderation', 'Your content was removed', b.note);
  }
  await actOnUser(req, r.reportedUserId, b.action, b.note, b.days);
  const status = b.dismiss || b.action === 'none' ? 'DISMISSED' : 'RESOLVED';
  const actionText = b.removeContent && b.action !== 'remove' && b.action !== 'none' && r.targetType !== 'user' ? `${b.action} + remove` : b.action;
  const closed = await db.update(reports).set({ status, resolution: b.note, action: actionText, resolvedBy: req.admin!.name, resolvedAt: new Date() }).where(and(eq(reports.targetId, r.targetId), eq(reports.status, 'OPEN'))).returning({ id: reports.id, reporterId: reports.reporterId });
  for (const c of closed) await notify(c.reporterId, 'moderation', 'Update on your report', status === 'RESOLVED' ? 'Thanks — we reviewed your report and took action.' : 'Thanks — we reviewed your report and it doesn’t break our rules.');
  await audit(req, 'moderation', `Report ${status.toLowerCase()} (${b.action}): ${b.note}`, r.targetLabel);
  res.json({ closed: closed.length, status });
}));

/** Change priority, or reopen a closed report. */
moderation.patch('/reports/:id', ah(async (req, res) => {
  const r = await db.query.reports.findFirst({ where: eq(reports.id, req.params.id) });
  if (!r) throw notFound('Report');
  const b = parse(z.object({ priority: z.enum(['urgent', 'normal']).optional(), reopen: z.boolean().optional() }), req.body);
  const patch: Partial<typeof reports.$inferInsert> = {};
  if (b.priority) patch.priority = b.priority;
  if (b.reopen) Object.assign(patch, { status: 'OPEN', action: '', resolution: '', resolvedBy: null, resolvedAt: null });
  const [row] = await db.update(reports).set(patch).where(eq(reports.id, r.id)).returning();
  await audit(req, 'moderation', b.reopen ? 'Reopened report' : `Report priority → ${b.priority}`, r.targetLabel);
  res.json({ report: row });
}));

/* ---------------------------- Content ---------------------------- */
moderation.get('/content', ah(async (req, res) => {
  const f = parse(z.object({ status: z.string().default('all'), type: z.string().optional(), flagged: z.enum(['true', 'false']).optional(), reported: z.enum(['true', 'false']).optional() }), req.query);
  const { page, limit, skip } = paging(req.query, 100);
  const w: SQL[] = [];
  if (f.status !== 'all') w.push(eq(posts.status, f.status.toUpperCase() as 'VISIBLE'));
  if (f.type) w.push(eq(posts.type, f.type.toUpperCase() as 'POST'));
  if (f.flagged === 'true') w.push(sql`${posts.flag} IS NOT NULL AND ${posts.reviewedBy} IS NULL`);
  if (f.reported === 'true') w.push(sql`${posts.reportsCount} > 0`);
  const where = w.length ? and(...w) : undefined;
  const [{ n }] = await db.select({ n: count() }).from(posts).where(where);
  const rows = await db.select({ p: posts, u: users }).from(posts).innerJoin(users, eq(users.id, posts.userId)).where(where).orderBy(desc(posts.reportsCount), desc(posts.createdAt)).limit(limit).offset(skip);
  res.json(pageResult(rows.map((r) => ({ ...r.p, author: { id: r.u.id, code: r.u.code, name: r.u.name, warnings: r.u.warnings } })), n, page, limit));
}));

/** hide (temporarily) | restore | remove (with reason, deletes the file) | approve (clear flag). Optional user action. */
moderation.post('/content/:id', ah(async (req, res) => {
  const p = await db.query.posts.findFirst({ where: eq(posts.id, req.params.id) });
  if (!p) throw notFound('Post');
  const b = parse(z.object({ action: z.enum(['hide', 'restore', 'remove', 'approve']), reason: z.string().trim().max(300).default(''), userAction: z.enum(['none', 'warn', 'mute', 'suspend', 'ban']).default('none'), days: z.coerce.number().int().min(1).max(365).default(7) }), req.body);
  if (b.action === 'remove' && b.reason.length < 3) throw badRequest('Add a reason the member will see');
  const patch = { hide: { status: 'HIDDEN' as const }, restore: { status: 'VISIBLE' as const, flag: null }, remove: { status: 'REMOVED' as const, removeReason: b.reason }, approve: { flag: null } }[b.action];
  const [row] = await db.update(posts).set({ ...patch, reviewedBy: req.admin!.name }).where(eq(posts.id, p.id)).returning();
  if (b.action === 'remove') { await removeFile(p.mediaUrl); await notify(p.userId, 'moderation', 'Your post was removed', b.reason); }
  if (b.action === 'restore' || b.action === 'approve') await db.update(reports).set({ status: 'DISMISSED', resolution: 'Content reviewed: OK', resolvedBy: req.admin!.name, resolvedAt: new Date() }).where(and(eq(reports.targetId, p.id), eq(reports.status, 'OPEN')));
  if (b.action === 'remove') await db.update(reports).set({ status: 'RESOLVED', action: 'remove', resolution: b.reason, resolvedBy: req.admin!.name, resolvedAt: new Date() }).where(and(eq(reports.targetId, p.id), eq(reports.status, 'OPEN')));
  await actOnUser(req, p.userId, b.userAction, b.reason || 'Community rules', b.days);
  await audit(req, 'moderation', `Post ${b.action}${b.reason ? `: ${b.reason}` : ''}`, (p.text || p.type).slice(0, 80));
  res.json({ post: row });
}));

/* ---------------------------- Chat reports & flagged messages ---------------------------- */
moderation.get('/chat-reports', ah(async (req, res) => {
  const status = String(req.query.status ?? 'OPEN').toUpperCase();
  const rows = await db.select().from(chatReports).where(status === 'ALL' ? undefined : eq(chatReports.status, status as 'OPEN')).orderBy(asc(chatReports.createdAt)).limit(200);
  const people = await db.select().from(users).where(inArray(users.id, [...new Set(rows.flatMap((r) => [r.reporterId, r.reportedId]))].concat('-')));
  res.json({ items: rows.map((r) => ({ ...r, reporter: people.find((p) => p.id === r.reporterId) ? publicUser(people.find((p) => p.id === r.reporterId)!) : null, reported: people.find((p) => p.id === r.reportedId) ? adminUser(people.find((p) => p.id === r.reportedId)!) : null })) });
}));

/** The reported chat. Moderators see the last 100 messages for context; viewing is audited. */
moderation.get('/chat-reports/:id', ah(async (req, res) => {
  const r = await db.query.chatReports.findFirst({ where: eq(chatReports.id, req.params.id) });
  if (!r) throw notFound('Chat report');
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, r.conversationId)).orderBy(desc(messages.createdAt)).limit(100);
  await audit(req, 'moderation', 'Opened reported chat', r.id);
  res.json({ report: r, messages: msgs.reverse().map((m) => ({ ...m, reported: r.messageIds.includes(m.id), fromReported: m.senderId === r.reportedId })) });
}));

moderation.post('/chat-reports/:id/resolve', ah(async (req, res) => {
  const r = await db.query.chatReports.findFirst({ where: eq(chatReports.id, req.params.id) });
  if (!r) throw notFound('Chat report');
  const b = parse(z.object({ action: z.enum(['none', 'warn', 'mute', 'suspend', 'ban']), note: z.string().trim().min(3).max(500), days: z.coerce.number().int().min(1).max(365).default(7) }), req.body);
  await actOnUser(req, r.reportedId, b.action, b.note, b.days);
  const [row] = await db.update(chatReports).set({ status: b.action === 'none' ? 'DISMISSED' : 'RESOLVED', action: b.action, resolution: b.note, resolvedBy: req.admin!.name }).where(eq(chatReports.id, r.id)).returning();
  await notify(r.reporterId, 'moderation', 'Update on your chat report', b.action === 'none' ? 'We reviewed the chat and didn’t find a rule break.' : 'Thanks — we reviewed the chat and took action.');
  res.json({ report: row });
}));

/** Messages caught by the blocked-words filter (last 30 days). */
moderation.get('/flagged-messages', ah(async (_req, res) => {
  const rows = await db.select({ m: messages, u: users, c: conversations }).from(messages).innerJoin(users, eq(users.id, messages.senderId)).innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(sql`${messages.flagged} IS NOT NULL AND ${messages.createdAt} > now() - interval '30 days'`).orderBy(desc(messages.createdAt)).limit(200);
  res.json({ items: rows.map((r) => ({ id: r.m.id, text: r.m.text, flagged: r.m.flagged, createdAt: r.m.createdAt, conversationId: r.c.id, sender: { id: r.u.id, code: r.u.code, name: r.u.name, warnings: r.u.warnings } })) });
}));
