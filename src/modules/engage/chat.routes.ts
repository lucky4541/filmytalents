import { Router } from 'express';
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import type { User } from '../../db/schema';
import { ah, parse } from '../../lib/http';
import { badRequest, forbidden, notFound, paymentRequired, tooMany } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import { publicUser } from '../../lib/serialize';
import { emitToUser } from '../../realtime';
import { planAllows, requireMember } from '../../middleware/auth';

const { conversations, messages, users, blocks, chatReports } = schema;

/**
 * Member chat — a Pro feature. Pro members can start chats and reply; Free members can read
 * messages they receive and see an "Upgrade to reply" prompt. Phone numbers can't be shared,
 * and messages asking for money are flagged for the moderation team.
 */
const router = Router();
router.use(requireMember);

const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];
const other = (c: typeof conversations.$inferSelect, me: string) => (c.aId === me ? c.bId : c.aId);
const PHONE = /(?:\+?91[\s-]*)?[6-9](?:[\s-]*\d){9}/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;

async function chatSettings() {
  const [chat, features] = await Promise.all([
    getSetting<{ dailyLimit?: number; blockPhoneNumbers?: boolean; blockedWords?: string }>('chat', {}),
    getSetting<{ chat?: boolean }>('features', {}),
  ]);
  return { ...chat, enabled: features.chat !== false };
}

async function blockedBetween(a: string, b: string) {
  return !!(await db.query.blocks.findFirst({ where: or(and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)), and(eq(blocks.blockerId, b), eq(blocks.blockedId, a))) }));
}

function canReceive(u: User) {
  if (u.status !== 'ACTIVE') return 'This member is not available';
  if (u.isMinor) return 'Members under 18 can’t be messaged. Contact goes through the casting team.';
  if ((u.privacy as Record<string, boolean>).allowMessages === false) return 'This member has turned off messages';
  return null;
}

/** My chats, newest first, with the other member and unread count. */
router.get('/', ah(async (req, res) => {
  const me = req.user!.id;
  const rows = await db.select().from(conversations).where(or(eq(conversations.aId, me), eq(conversations.bId, me))).orderBy(desc(conversations.lastMessageAt)).limit(100);
  const canSend = await planAllows(req.user!, 'chat');
  if (!rows.length) return res.json({ canSend, items: [] });
  const ids = rows.map((r) => r.id);
  const people = await db.select().from(users).where(inArray(users.id, rows.map((r) => other(r, me))));
  const unread = await db.select({ c: messages.conversationId, n: count() }).from(messages).where(and(inArray(messages.conversationId, ids), ne(messages.senderId, me), isNull(messages.readAt))).groupBy(messages.conversationId);
  const last = await db.execute<{ conversation_id: string; text: string; sender_id: string; created_at: Date }>(sql`SELECT DISTINCT ON (conversation_id) conversation_id, text, sender_id, created_at FROM messages WHERE conversation_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) ORDER BY conversation_id, created_at DESC`);
  const myBlocks = new Set((await db.select({ id: blocks.blockedId }).from(blocks).where(eq(blocks.blockerId, me))).map((b) => b.id));
  res.json({
    canSend,
    items: rows.map((c) => {
      const o = people.find((p) => p.id === other(c, me));
      const l = last.rows.find((x) => x.conversation_id === c.id);
      return { id: c.id, with: o ? publicUser(o) : null, blockedByMe: o ? myBlocks.has(o.id) : false, lastMessage: l ? { text: l.text, mine: l.sender_id === me, at: l.created_at } : null, unread: unread.find((u) => u.c === c.id)?.n ?? 0, lastMessageAt: c.lastMessageAt };
    }),
  });
}));

router.get('/unread-count', ah(async (req, res) => {
  const me = req.user!.id;
  const [{ n }] = await db.select({ n: count() }).from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(or(eq(conversations.aId, me), eq(conversations.bId, me)), ne(messages.senderId, me), isNull(messages.readAt)));
  res.json({ unread: n });
}));

/** Open (or create) a chat with a member by their code. Pro only. */
router.post('/start', ah(async (req, res) => {
  const me = req.user!;
  if (!(await planAllows(me, 'chat'))) throw paymentRequired('Chat isn’t included in your plan. Upgrade to message other members.');
  const s = await chatSettings();
  if (!s.enabled) throw forbidden('Chat is paused right now');
  const { code } = parse(z.object({ code: z.string().min(3).max(20) }), req.body);
  const to = await db.query.users.findFirst({ where: eq(users.code, code.toUpperCase()) });
  if (!to || to.id === me.id) throw notFound('Member');
  const why = canReceive(to);
  if (why) throw forbidden(why);
  if (await blockedBetween(me.id, to.id)) throw forbidden('You can’t message this member');
  const [aId, bId] = pair(me.id, to.id);
  await db.insert(conversations).values({ aId, bId }).onConflictDoNothing();
  const c = (await db.query.conversations.findFirst({ where: and(eq(conversations.aId, aId), eq(conversations.bId, bId)) }))!;
  res.json({ conversation: { id: c.id, with: publicUser(to) } });
}));

async function mine(id: string, me: string) {
  const c = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
  if (!c || (c.aId !== me && c.bId !== me)) throw notFound('Chat');
  return c;
}

/** Messages, newest page first. Pass ?before=<ISO date> for older ones. */
router.get('/:id/messages', ah(async (req, res) => {
  const c = await mine(req.params.id, req.user!.id);
  const before = req.query.before ? new Date(String(req.query.before)) : undefined;
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const rows = await db.select().from(messages).where(and(eq(messages.conversationId, c.id), before ? lt(messages.createdAt, before) : undefined)).orderBy(desc(messages.createdAt)).limit(limit);
  const o = await db.query.users.findFirst({ where: eq(users.id, other(c, req.user!.id)) });
  res.json({
    with: o ? publicUser(o) : null, canSend: await planAllows(req.user!, 'chat'),
    items: rows.reverse().map((m) => ({ id: m.id, text: m.text, mine: m.senderId === req.user!.id, readAt: m.readAt, createdAt: m.createdAt, flagged: m.senderId === req.user!.id ? !!m.flagged : false })),
    next: rows.length === limit ? rows[0].createdAt : null,
  });
}));

router.post('/:id/messages', ah(async (req, res) => {
  const me = req.user!;
  const c = await mine(req.params.id, me.id);
  if (!(await planAllows(me, 'chat'))) throw paymentRequired('Chat isn’t included in your plan. Upgrade to reply.');
  if (me.chatMutedUntil && me.chatMutedUntil > new Date()) throw forbidden(`You can’t send messages until ${me.chatMutedUntil.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  const s = await chatSettings();
  if (!s.enabled) throw forbidden('Chat is paused right now');
  const { text } = parse(z.object({ text: z.string().trim().min(1, 'Type a message').max(2000) }), req.body);
  const toId = other(c, me.id);
  const to = await db.query.users.findFirst({ where: eq(users.id, toId) });
  if (!to) throw notFound('Member');
  const why = canReceive(to);
  if (why) throw forbidden(why);
  if (await blockedBetween(me.id, toId)) throw forbidden('You can’t message this member');
  if (s.blockPhoneNumbers !== false && (PHONE.test(text) || EMAIL.test(text))) throw badRequest('For your safety, phone numbers and emails can’t be shared in chat. Casting teams contact selected talent directly.');
  const limit = s.dailyLimit ?? 50;
  const [{ n }] = await db.select({ n: count() }).from(messages).where(and(eq(messages.senderId, me.id), gte(messages.createdAt, new Date(Date.now() - 86_400_000))));
  if (n >= limit) throw tooMany(`You can send up to ${limit} messages a day`);
  const words = (s.blockedWords ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  const hit = words.find((w) => text.toLowerCase().includes(w));
  const [m] = await db.insert(messages).values({ conversationId: c.id, senderId: me.id, text, flagged: hit ? `Blocked word: ${hit}` : null }).returning();
  await db.update(conversations).set({ lastMessageAt: m.createdAt }).where(eq(conversations.id, c.id));
  emitToUser(toId, 'message', { conversationId: c.id, id: m.id, text: m.text, from: publicUser(me), createdAt: m.createdAt });
  res.status(201).json({ message: { id: m.id, text: m.text, mine: true, createdAt: m.createdAt, flagged: !!hit }, warning: hit ? 'Never ask for or send money for auditions. This message was sent to our safety team.' : undefined });
}));

router.post('/:id/read', ah(async (req, res) => {
  const c = await mine(req.params.id, req.user!.id);
  const rows = await db.update(messages).set({ readAt: new Date() }).where(and(eq(messages.conversationId, c.id), ne(messages.senderId, req.user!.id), isNull(messages.readAt))).returning({ id: messages.id });
  if (rows.length) emitToUser(other(c, req.user!.id), 'read', { conversationId: c.id });
  res.json({ read: rows.length });
}));

/** Report a chat to the safety team. */
router.post('/:id/report', ah(async (req, res) => {
  const c = await mine(req.params.id, req.user!.id);
  const b = parse(z.object({ reason: z.string().trim().min(3).max(200), messageIds: z.array(z.string()).max(50).default([]), block: z.boolean().default(false) }), req.body);
  const reportedId = other(c, req.user!.id);
  const [r] = await db.insert(chatReports).values({ reporterId: req.user!.id, reportedId, conversationId: c.id, reason: b.reason, messageIds: b.messageIds }).returning();
  if (b.block) await db.insert(blocks).values({ blockerId: req.user!.id, blockedId: reportedId }).onConflictDoNothing();
  res.status(201).json({ report: { id: r.id, status: r.status } });
}));

export default router;
