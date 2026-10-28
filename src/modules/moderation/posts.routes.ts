import { Router } from 'express';
import { and, count, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, parse } from '../../lib/http';
import { badRequest, forbidden, notFound, paymentRequired } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import { publicUser } from '../../lib/serialize';
import { removeFile, runUpload, saveFile, uploader } from '../../lib/storage';
import { optionalMember, planAllows, requireMember } from '../../middleware/auth';
import { notify } from '../../lib/notify';

const { posts, likes, users, follows } = schema;

/** Community feed: photo / video / text posts and comments. Video posts are Pro only. */
const router = Router();

async function features() {
  return getSetting<{ community?: boolean; videoPosts?: boolean }>('features', {});
}

async function flagFor(text: string) {
  const chat = await getSetting<{ blockedWords?: string }>('chat', {});
  const words = (chat.blockedWords ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  const hit = words.find((w) => text.toLowerCase().includes(w));
  return hit ? `Blocked word: ${hit}` : /(?:\+?91[\s-]*)?[6-9](?:[\s-]*\d){9}/.test(text) ? 'Phone number' : null;
}

const notBlocked = (viewer: string) => sql`${posts.userId} NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ${viewer} UNION SELECT blocker_id FROM blocks WHERE blocked_id = ${viewer})`;

async function shape(rows: (typeof posts.$inferSelect)[], viewerId?: string) {
  if (!rows.length) return [];
  const authors = await db.select().from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.userId))]));
  const liked = viewerId ? new Set((await db.select({ id: likes.postId }).from(likes).where(and(eq(likes.userId, viewerId), inArray(likes.postId, rows.map((r) => r.id))))).map((l) => l.id)) : new Set<string>();
  const comments = await db.select({ p: posts.parentId, n: count() }).from(posts).where(and(inArray(posts.parentId, rows.map((r) => r.id)), eq(posts.status, 'VISIBLE'))).groupBy(posts.parentId);
  return rows.map((p) => {
    const a = authors.find((u) => u.id === p.userId);
    return { id: p.id, type: p.type, text: p.text, mediaUrl: p.mediaUrl, parentId: p.parentId, likes: p.likesCount, comments: comments.find((c) => c.p === p.id)?.n ?? 0, liked: liked.has(p.id), mine: p.userId === viewerId, createdAt: p.createdAt, author: a ? publicUser(a) : null };
  });
}

/** Feed. ?following=true for people I follow; ?user=<code> for one member; ?before=<ISO> to page. */
router.get('/', optionalMember, ah(async (req, res) => {
  if ((await features()).community === false) return res.json({ items: [], next: null, disabled: true });
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const w: SQL[] = [eq(posts.status, 'VISIBLE'), isNull(posts.parentId)];
  if (req.user) w.push(notBlocked(req.user.id));
  if (req.query.before) w.push(lt(posts.createdAt, new Date(String(req.query.before))));
  if (req.query.type && ['PHOTO', 'VIDEO', 'POST'].includes(String(req.query.type).toUpperCase())) w.push(eq(posts.type, String(req.query.type).toUpperCase() as 'PHOTO'));
  if (req.query.following === 'true' && req.user) w.push(sql`${posts.userId} IN (SELECT ${follows.followingId} FROM ${follows} WHERE ${follows.followerId} = ${req.user.id})`);
  if (req.query.user) {
    const u = await db.query.users.findFirst({ where: eq(users.code, String(req.query.user).toUpperCase()), columns: { id: true } });
    if (!u) throw notFound('Member');
    w.push(eq(posts.userId, u.id));
  }
  w.push(sql`${posts.userId} IN (SELECT id FROM users WHERE status = 'ACTIVE')`);
  const rows = await db.select().from(posts).where(and(...w)).orderBy(desc(posts.createdAt)).limit(limit);
  res.json({ items: await shape(rows, req.user?.id), next: rows.length === limit ? rows[rows.length - 1].createdAt : null });
}));

/** New post. JSON { text } for text, or multipart { text, file } for photo/video. */
router.post('/', requireMember, ah(async (req, res) => {
  const f = await features();
  if (f.community === false) throw forbidden('Community posts are paused right now');
  let mediaUrl: string | null = null;
  let type: 'POST' | 'PHOTO' | 'VIDEO' = 'POST';
  if (req.is('multipart/form-data')) {
    const kind = String(req.query.kind ?? 'photo') === 'video' ? 'video' : 'photo';
    if (kind === 'video') {
      if (f.videoPosts === false) throw forbidden('Video posts are paused right now');
      if (!(await planAllows(req.user!, 'videoPosts'))) throw paymentRequired('Video posts aren’t included in your plan. Upgrade to post videos.');
    }
    await runUpload(uploader(kind).single('file'), req, res);
    mediaUrl = await saveFile(req.file, kind, `posts/${req.user!.id}`);
    type = kind === 'video' ? 'VIDEO' : 'PHOTO';
  }
  const { text } = parse(z.object({ text: z.string().trim().max(2000).default('') }), req.body);
  if (!text && !mediaUrl) throw badRequest('Write something or add a photo');
  const [{ n }] = await db.select({ n: count() }).from(posts).where(and(eq(posts.userId, req.user!.id), sql`${posts.createdAt} > now() - interval '1 day'`, isNull(posts.parentId)));
  if (n >= 20) throw badRequest('You can post up to 20 times a day');
  const flag = await flagFor(text);
  const [p] = await db.insert(posts).values({ userId: req.user!.id, type, text, mediaUrl, flag }).returning();
  res.status(201).json({ post: (await shape([p], req.user!.id))[0] });
}));

router.get('/:id', optionalMember, ah(async (req, res) => {
  const p = await db.query.posts.findFirst({ where: and(eq(posts.id, req.params.id), eq(posts.status, 'VISIBLE')) });
  if (!p) throw notFound('Post');
  const comments = await db.select().from(posts).where(and(eq(posts.parentId, p.id), eq(posts.status, 'VISIBLE'))).orderBy(posts.createdAt).limit(200);
  res.json({ post: (await shape([p], req.user?.id))[0], comments: await shape(comments, req.user?.id) });
}));

router.post('/:id/comments', requireMember, ah(async (req, res) => {
  const p = await db.query.posts.findFirst({ where: and(eq(posts.id, req.params.id), eq(posts.status, 'VISIBLE'), isNull(posts.parentId)) });
  if (!p) throw notFound('Post');
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(1000) }), req.body);
  const blocked = await db.query.blocks.findFirst({ where: sql`(blocker_id = ${p.userId} AND blocked_id = ${req.user!.id}) OR (blocker_id = ${req.user!.id} AND blocked_id = ${p.userId})` });
  if (blocked) throw forbidden('You can’t comment on this post');
  const [c] = await db.insert(posts).values({ userId: req.user!.id, type: 'COMMENT', text, parentId: p.id, flag: await flagFor(text) }).returning();
  if (p.userId !== req.user!.id) await notify(p.userId, 'comment', `${req.user!.name || 'Someone'} commented on your post`, text.slice(0, 100), `/community/${p.id}`);
  res.status(201).json({ comment: (await shape([c], req.user!.id))[0] });
}));

router.post('/:id/like', requireMember, ah(async (req, res) => {
  const p = await db.query.posts.findFirst({ where: and(eq(posts.id, req.params.id), eq(posts.status, 'VISIBLE')) });
  if (!p) throw notFound('Post');
  const ins = await db.insert(likes).values({ userId: req.user!.id, postId: p.id }).onConflictDoNothing().returning();
  if (ins.length) await db.update(posts).set({ likesCount: sql`${posts.likesCount} + 1` }).where(eq(posts.id, p.id));
  res.json({ liked: true, likes: p.likesCount + ins.length });
}));

router.delete('/:id/like', requireMember, ah(async (req, res) => {
  const del = await db.delete(likes).where(and(eq(likes.userId, req.user!.id), eq(likes.postId, req.params.id))).returning();
  if (del.length) await db.update(posts).set({ likesCount: sql`greatest(${posts.likesCount} - 1, 0)` }).where(eq(posts.id, req.params.id));
  res.json({ liked: false });
}));

router.delete('/:id', requireMember, ah(async (req, res) => {
  const [p] = await db.delete(posts).where(and(eq(posts.id, req.params.id), eq(posts.userId, req.user!.id))).returning();
  if (!p) throw notFound('Post');
  await db.delete(posts).where(eq(posts.parentId, p.id));
  await removeFile(p.mediaUrl);
  res.json({ ok: true });
}));

export default router;
