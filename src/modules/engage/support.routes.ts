import { Router } from 'express';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { fill, notify } from '../../lib/notify';
import { emitToAdmins, emitToUser } from '../../realtime';
import { adminUser } from '../../lib/serialize';
import { requireAdmin, requireMember, requirePerm } from '../../middleware/auth';

const { tickets, ticketMessages, cannedReplies, users, admins } = schema;
const CATEGORIES = ['Account & login', 'Payments & plans', 'Auditions & applications', 'Verification', 'Report a scam', 'Bug or problem', 'Something else'] as const;
const STATUSES = ['open', 'pending', 'solved', 'closed'] as const;

/* ============================ Member: Help & support ============================ */
export const memberSupport = Router();
memberSupport.use(requireMember);

memberSupport.get('/categories', (_req, res) => { res.json({ items: CATEGORIES }); });

memberSupport.get('/tickets', ah(async (req, res) => {
  const rows = await db.select().from(tickets).where(eq(tickets.userId, req.user!.id)).orderBy(desc(tickets.updatedAt)).limit(100);
  res.json({ items: rows });
}));

memberSupport.post('/tickets', ah(async (req, res) => {
  const b = parse(z.object({ subject: z.string().trim().min(4, 'Add a short subject').max(120), category: z.enum(CATEGORIES), text: z.string().trim().min(10, 'Tell us a bit more').max(4000), channel: z.enum(['app', 'chat']).default('app') }), req.body);
  const [{ n }] = await db.select({ n: count() }).from(tickets).where(and(eq(tickets.userId, req.user!.id), inArray(tickets.status, ['open', 'pending'])));
  if (n >= 5) throw badRequest('You already have 5 open requests. We’ll reply soon.');
  const priority = b.category === 'Report a scam' ? 'urgent' : b.category === 'Payments & plans' ? 'high' : 'normal';
  const [t] = await db.insert(tickets).values({ userId: req.user!.id, subject: b.subject, category: b.category, priority, channel: b.channel }).returning();
  await db.insert(ticketMessages).values({ ticketId: t.id, fromAdmin: false, name: req.user!.name || 'Member', text: b.text });
  emitToAdmins('support:ticket', { ticketId: t.id, number: t.number, subject: t.subject, isNew: true });
  res.status(201).json({ ticket: t });
}));

async function myTicket(id: string, userId: string) {
  const t = await db.query.tickets.findFirst({ where: and(eq(tickets.id, id), eq(tickets.userId, userId)) });
  if (!t) throw notFound('Request');
  return t;
}

memberSupport.get('/tickets/:id', ah(async (req, res) => {
  const t = await myTicket(req.params.id, req.user!.id);
  const msgs = await db.select().from(ticketMessages).where(and(eq(ticketMessages.ticketId, t.id), eq(ticketMessages.internal, false))).orderBy(asc(ticketMessages.createdAt));
  res.json({ ticket: t, messages: msgs.map(({ internal: _i, ...m }) => m) });
}));

memberSupport.post('/tickets/:id/reply', ah(async (req, res) => {
  const t = await myTicket(req.params.id, req.user!.id);
  if (t.status === 'closed') throw badRequest('This request is closed. Please start a new one.');
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(4000) }), req.body);
  const [m] = await db.insert(ticketMessages).values({ ticketId: t.id, fromAdmin: false, name: req.user!.name || 'Member', text }).returning();
  await db.update(tickets).set({ status: 'open' }).where(eq(tickets.id, t.id));
  const { internal: _i, ...pub } = m;
  emitToAdmins('support:message', { ticketId: t.id, message: m });
  emitToUser(t.userId, 'support:message', { ticketId: t.id, message: pub });
  res.status(201).json({ message: m });
}));

memberSupport.post('/tickets/:id/close', ah(async (req, res) => {
  const t = await myTicket(req.params.id, req.user!.id);
  await db.update(tickets).set({ status: 'closed' }).where(eq(tickets.id, t.id));
  res.json({ ok: true });
}));

/* ============================ Admin: Support desk ============================ */
export const adminSupport = Router();
adminSupport.use(requireAdmin, requirePerm('support'));

adminSupport.get('/tickets', ah(async (req, res) => {
  const f = parse(z.object({ status: z.string().optional(), priority: z.string().optional(), category: z.string().optional(), assignee: z.string().optional(), q: z.string().trim().max(80).optional() }), req.query);
  const { page, limit, skip } = paging(req.query, 100);
  const w: SQL[] = [];
  if (f.status && f.status !== 'all') w.push(inArray(tickets.status, f.status.split(',')));
  if (f.priority) w.push(eq(tickets.priority, f.priority));
  if (f.category) w.push(eq(tickets.category, f.category));
  if (f.assignee === 'me') w.push(eq(tickets.assigneeId, req.admin!.id));
  else if (f.assignee === 'none') w.push(isNull(tickets.assigneeId));
  else if (f.assignee) w.push(eq(tickets.assigneeId, f.assignee));
  if (f.q) w.push(or(ilike(tickets.subject, `%${f.q}%`), ilike(users.name, `%${f.q}%`), ilike(users.code, `%${f.q}%`), sql`${tickets.number}::text = ${f.q.replace(/\D/g, '') || '-1'}`)!);
  const where = w.length ? and(...w) : undefined;
  const prio = sql`CASE ${tickets.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;
  const [{ n }] = await db.select({ n: count() }).from(tickets).innerJoin(users, eq(users.id, tickets.userId)).where(where);
  const rows = await db.select({ t: tickets, u: users, a: admins }).from(tickets).innerJoin(users, eq(users.id, tickets.userId)).leftJoin(admins, eq(admins.id, tickets.assigneeId))
    .where(where).orderBy(prio, desc(tickets.updatedAt)).limit(limit).offset(skip);
  const [stats] = await db.select({
    open: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'open')`.mapWith(Number),
    pending: sql<number>`count(*) FILTER (WHERE ${tickets.status} = 'pending')`.mapWith(Number),
    urgent: sql<number>`count(*) FILTER (WHERE ${tickets.priority} = 'urgent' AND ${tickets.status} IN ('open','pending'))`.mapWith(Number),
    unassigned: sql<number>`count(*) FILTER (WHERE ${tickets.assigneeId} IS NULL AND ${tickets.status} IN ('open','pending'))`.mapWith(Number),
    avgFirstResponseMins: sql<number>`coalesce(round(avg(${tickets.firstResponseMins})), 0)`.mapWith(Number),
  }).from(tickets);
  res.json({ stats, ...pageResult(rows.map((r) => ({ ...r.t, member: { id: r.u.id, code: r.u.code, name: r.u.name, plan: r.u.planId }, assignee: r.a ? { id: r.a.id, name: r.a.name } : null })), n, page, limit) });
}));

/** Team members tickets can be assigned to. */
adminSupport.get('/agents', ah(async (_req, res) => {
  const rows = await db.select({ id: admins.id, name: admins.name, role: admins.role }).from(admins).where(eq(admins.status, 'ACTIVE')).orderBy(asc(admins.name));
  res.json({ items: rows });
}));

/** Ticket for a member who phoned, emailed or messaged on WhatsApp. */
adminSupport.post('/tickets', ah(async (req, res) => {
  const b = parse(z.object({
    userId: z.string().min(1), subject: z.string().trim().min(3).max(140), category: z.enum(CATEGORIES), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    channel: z.enum(['app', 'phone', 'whatsapp', 'email']).default('phone'), message: z.string().trim().min(3).max(4000), assigneeId: z.string().nullable().optional(),
  }), req.body);
  const u = await db.query.users.findFirst({ where: eq(users.id, b.userId) });
  if (!u) throw notFound('Member');
  const [t] = await db.insert(tickets).values({ userId: u.id, subject: b.subject, category: b.category, priority: b.priority, channel: b.channel, assigneeId: b.assigneeId === undefined ? req.admin!.id : b.assigneeId }).returning();
  await db.insert(ticketMessages).values({ ticketId: t.id, fromAdmin: false, name: u.name || 'Member', text: b.message });
  await audit(req, 'support', `Created ticket #${t.number} (${b.channel})`, b.subject);
  emitToAdmins('support:ticket', { ticketId: t.id, number: t.number, subject: t.subject, isNew: true });
  emitToUser(u.id, 'support:ticket', { ticketId: t.id, status: t.status });
  res.status(201).json({ ticket: t });
}));

async function loadTicket(id: string) {
  const t = await db.query.tickets.findFirst({ where: eq(tickets.id, id) });
  if (!t) throw notFound('Ticket');
  return t;
}

adminSupport.get('/tickets/:id', ah(async (req, res) => {
  const t = await loadTicket(req.params.id);
  const [u, msgs, others] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, t.userId) }),
    db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t.id)).orderBy(asc(ticketMessages.createdAt)),
    db.select().from(tickets).where(and(eq(tickets.userId, t.userId))).orderBy(desc(tickets.createdAt)).limit(10),
  ]);
  res.json({ ticket: t, member: u ? adminUser(u) : null, messages: msgs, otherTickets: others.filter((o) => o.id !== t.id) });
}));

/** Reply to the member (or an internal note with internal: true). {name} in the text becomes the member's first name. */
adminSupport.post('/tickets/:id/reply', ah(async (req, res) => {
  const t = await loadTicket(req.params.id);
  const b = parse(z.object({ text: z.string().trim().min(1).max(4000), internal: z.boolean().default(false), status: z.enum(STATUSES).optional() }), req.body);
  const u = await db.query.users.findFirst({ where: eq(users.id, t.userId) });
  const text = fill(b.text, { name: (u?.name ?? '').split(' ')[0] || 'there' });
  const [m] = await db.insert(ticketMessages).values({ ticketId: t.id, fromAdmin: true, name: req.admin!.name, text, internal: b.internal }).returning();
  const patch: Partial<typeof tickets.$inferInsert> = {};
  if (!b.internal) {
    patch.status = b.status ?? 'pending';
    if (t.firstResponseMins === null) patch.firstResponseMins = Math.round((Date.now() - t.createdAt.getTime()) / 60_000);
    if (!t.assigneeId) patch.assigneeId = req.admin!.id;
    await notify(t.userId, 'support', `Reply on #${t.number}: ${t.subject}`, text.slice(0, 140), `/support/${t.id}`);
  } else if (b.status) patch.status = b.status;
  if (Object.keys(patch).length) await db.update(tickets).set(patch).where(eq(tickets.id, t.id));
  emitToAdmins('support:message', { ticketId: t.id, message: m });
  if (!b.internal) {
    const { internal: _i, ...pub } = m;
    emitToUser(t.userId, 'support:message', { ticketId: t.id, message: pub, status: patch.status ?? t.status });
  } else if (b.status) emitToUser(t.userId, 'support:ticket', { ticketId: t.id, status: b.status });
  res.status(201).json({ message: m });
}));

adminSupport.patch('/tickets/:id', ah(async (req, res) => {
  const t = await loadTicket(req.params.id);
  const b = parse(z.object({ status: z.enum(STATUSES), priority: z.enum(['low', 'normal', 'high', 'urgent']), assigneeId: z.string().nullable(), category: z.enum(CATEGORIES) }).partial(), req.body);
  if (b.assigneeId) {
    const a = await db.query.admins.findFirst({ where: eq(admins.id, b.assigneeId) });
    if (!a || a.status !== 'ACTIVE') throw badRequest('Pick an active team member');
  }
  const [row] = await db.update(tickets).set(b).where(eq(tickets.id, t.id)).returning();
  await audit(req, 'support', `Ticket #${t.number}: ${Object.entries(b).map(([k, v]) => `${k} → ${v ?? 'none'}`).join(', ')}`, t.subject);
  res.json({ ticket: row });
}));

/* ---------------------------- Canned replies ---------------------------- */
adminSupport.get('/canned', ah(async (_req, res) => { res.json({ items: await db.select().from(cannedReplies).orderBy(asc(cannedReplies.title)) }); }));

const canned = z.object({ title: z.string().trim().min(2).max(60), text: z.string().trim().min(5).max(2000) });
adminSupport.post('/canned', ah(async (req, res) => {
  const [item] = await db.insert(cannedReplies).values(parse(canned, req.body)).returning();
  res.status(201).json({ item });
}));
adminSupport.patch('/canned/:id', ah(async (req, res) => {
  const [item] = await db.update(cannedReplies).set(parse(canned.partial(), req.body)).where(eq(cannedReplies.id, req.params.id)).returning();
  if (!item) throw notFound('Reply');
  res.json({ item });
}));
adminSupport.delete('/canned/:id', ah(async (req, res) => {
  await db.delete(cannedReplies).where(eq(cannedReplies.id, req.params.id));
  res.json({ ok: true });
}));
