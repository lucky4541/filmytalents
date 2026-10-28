import { Router } from 'express';
import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, parse } from '../../lib/http';
import { requireMember } from '../../middleware/auth';

const { notifications } = schema;

/** The bell icon: my notifications. */
const router = Router();
router.use(requireMember);

router.get('/', ah(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const before = req.query.before ? new Date(String(req.query.before)) : undefined;
  const rows = await db.select().from(notifications).where(and(eq(notifications.userId, req.user!.id), before ? lt(notifications.createdAt, before) : undefined)).orderBy(desc(notifications.createdAt)).limit(limit);
  const [{ n }] = await db.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt)));
  res.json({ unread: n, items: rows, next: rows.length === limit ? rows[rows.length - 1].createdAt : null });
}));

router.get('/unread-count', ah(async (req, res) => {
  const [{ n }] = await db.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, req.user!.id), isNull(notifications.readAt)));
  res.json({ unread: n });
}));

/** { ids: [...] } or { all: true } */
router.post('/read', ah(async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.string()).max(200).optional(), all: z.boolean().optional() }), req.body);
  const mine = eq(notifications.userId, req.user!.id);
  if (b.all) await db.update(notifications).set({ readAt: new Date() }).where(and(mine, isNull(notifications.readAt)));
  else if (b.ids?.length) await db.update(notifications).set({ readAt: new Date() }).where(and(mine, inArray(notifications.id, b.ids)));
  res.json({ ok: true });
}));

/** Campaign link tracking: the app calls this when a member taps a notification. */
router.post('/:id/click', ah(async (req, res) => {
  const [n] = await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, req.params.id), eq(notifications.userId, req.user!.id))).returning();
  if (n?.type.startsWith('campaign:')) {
    const id = n.type.slice('campaign:'.length);
    await db.update(schema.campaigns).set({ clicked: sql`${schema.campaigns.clicked} + 1` }).where(eq(schema.campaigns.id, id));
  }
  res.json({ ok: true, link: n?.link ?? null });
}));

router.delete('/:id', ah(async (req, res) => {
  await db.delete(notifications).where(and(eq(notifications.id, req.params.id), eq(notifications.userId, req.user!.id)));
  res.json({ ok: true });
}));

export default router;
