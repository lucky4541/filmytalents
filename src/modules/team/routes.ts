import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { env } from '../../config/env';
import { ah, parse } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { randomToken } from '../../lib/crypto';
import { adminPublic } from '../../lib/serialize';
import { clearPermCache, requireAdmin, requirePerm } from '../../middleware/auth';
import { revokeAllFor } from '../auth/tokens';
import { PERM_MODULES } from '../../db/defaults';

const { admins, rolePermissions } = schema;
const ROLES = ['Super Admin', 'Casting Manager', 'Moderator', 'Verification Officer', 'Support Agent', 'Content Manager', 'Finance'] as const;
const router = Router();
router.use(requireAdmin);

router.get('/', requirePerm('team'), ah(async (_req, res) => {
  const rows = await db.select().from(admins).orderBy(asc(admins.createdAt));
  res.json({ items: rows.map(adminPublic) });
}));

/** Invite a new admin. Returns the invite link (also emailed once email is connected). */
router.post('/', requirePerm('team'), ah(async (req, res) => {
  if (req.admin!.role !== 'Super Admin') throw forbidden('Only a Super Admin can invite admins');
  const body = parse(z.object({ name: z.string().min(2).max(80), email: z.string().email(), role: z.enum(ROLES), password: z.string().min(8).optional() }), req.body);
  const email = body.email.toLowerCase();
  if (await db.query.admins.findFirst({ where: eq(admins.email, email), columns: { id: true } })) throw conflict('This person is already on the team');
  const token = randomToken(24);
  const [a] = await db.insert(admins).values({
    name: body.name.trim(), email, role: body.role,
    // A password can be set directly (e.g. for your own staff); otherwise they accept an invite.
    ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 10), status: 'ACTIVE' as const } : { inviteToken: token, inviteExpiry: new Date(Date.now() + 48 * 3_600_000), status: 'INVITED' as const }),
  }).returning();
  await audit(req, 'Admin Team', `Invited admin as ${body.role}`, email);
  res.status(201).json({ admin: adminPublic(a), inviteUrl: body.password ? null : `${env.PUBLIC_APP_URL.replace(/:\d+$/, ':5174')}/admin/accept-invite?token=${token}` });
}));

async function guard(reqAdminId: string, target: { id: string; role: string; status: string }, what: string) {
  if (target.id === reqAdminId) throw badRequest(`You can’t ${what} yourself`);
  if (target.role === 'Super Admin' && target.status === 'ACTIVE') {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(admins).where(and(eq(admins.role, 'Super Admin'), eq(admins.status, 'ACTIVE'), ne(admins.id, target.id)));
    if (n === 0) throw badRequest('Keep at least one active Super Admin');
  }
}

router.patch('/:id', requirePerm('team'), ah(async (req, res) => {
  if (req.admin!.role !== 'Super Admin') throw forbidden('Only a Super Admin can change the team');
  const body = parse(z.object({ role: z.enum(ROLES).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), name: z.string().min(2).max(80).optional() }), req.body);
  const target = await db.query.admins.findFirst({ where: eq(admins.id, req.params.id) });
  if (!target) throw notFound('Admin');
  if ((body.role && body.role !== target.role && target.role === 'Super Admin') || body.status === 'DISABLED') await guard(req.admin!.id, target, body.status === 'DISABLED' ? 'disable' : 'change the role of');
  if (body.status === 'ACTIVE' && target.status === 'INVITED') throw badRequest('This person has not accepted the invite yet');
  const [a] = await db.update(admins).set(body).where(eq(admins.id, target.id)).returning();
  if (body.status === 'DISABLED') await revokeAllFor('admin', target.id);
  await audit(req, 'Admin Team', [body.role && `Changed role to ${body.role}`, body.status && (body.status === 'DISABLED' ? 'Disabled admin' : 'Enabled admin')].filter(Boolean).join(', ') || 'Edited admin', target.email);
  res.json({ admin: adminPublic(a) });
}));

router.post('/:id/resend-invite', requirePerm('team'), ah(async (req, res) => {
  const target = await db.query.admins.findFirst({ where: eq(admins.id, req.params.id) });
  if (!target) throw notFound('Admin');
  if (target.status !== 'INVITED') throw badRequest('This person already joined');
  const token = randomToken(24);
  await db.update(admins).set({ inviteToken: token, inviteExpiry: new Date(Date.now() + 48 * 3_600_000) }).where(eq(admins.id, target.id));
  await audit(req, 'Admin Team', 'Resent invite', target.email);
  res.json({ inviteUrl: `${env.PUBLIC_APP_URL.replace(/:\d+$/, ':5174')}/admin/accept-invite?token=${token}` });
}));

router.delete('/:id', requirePerm('team'), ah(async (req, res) => {
  if (req.admin!.role !== 'Super Admin') throw forbidden('Only a Super Admin can remove admins');
  const target = await db.query.admins.findFirst({ where: eq(admins.id, req.params.id) });
  if (!target) throw notFound('Admin');
  await guard(req.admin!.id, target, 'remove');
  await db.delete(admins).where(eq(admins.id, target.id));
  await audit(req, 'Admin Team', 'Removed admin', `${target.name} (${target.email})`);
  res.json({ ok: true });
}));

/* ---------- Roles & access ---------- */
router.get('/roles', requirePerm('team'), ah(async (_req, res) => {
  const rows = await db.select().from(rolePermissions);
  res.json({ roles: ROLES, modules: PERM_MODULES, permissions: Object.fromEntries(rows.map((r) => [r.role, r.role === 'Super Admin' ? PERM_MODULES : r.modules])) });
}));

router.put('/roles/:role', requirePerm('team'), ah(async (req, res) => {
  if (req.admin!.role !== 'Super Admin') throw forbidden('Only a Super Admin can change access');
  const role = decodeURIComponent(req.params.role);
  if (!ROLES.includes(role as (typeof ROLES)[number])) throw notFound('Role');
  if (role === 'Super Admin') throw badRequest('Super Admin always has full access');
  const { modules } = parse(z.object({ modules: z.array(z.enum(PERM_MODULES as [string, ...string[]])) }), req.body);
  const clean = modules.filter((m) => m !== 'team' && (m !== 'settings' || role === 'Finance'));
  await db.insert(rolePermissions).values({ role, modules: clean }).onConflictDoUpdate({ target: rolePermissions.role, set: { modules: clean } });
  clearPermCache();
  await audit(req, 'Admin Team', `Updated access: ${clean.join(', ') || 'none'}`, role);
  res.json({ role, modules: clean });
}));

export default router;
