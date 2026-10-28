import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, parse } from '../../lib/http';
import { badRequest, forbidden, tooMany, unauthorized } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { getSetting } from '../../lib/settings';
import { adminPublic } from '../../lib/serialize';
import { requireAdmin } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import { issueTokens, revoke, revokeAllFor, rotate } from './tokens';

const { admins, rolePermissions } = schema;
const router = Router();

// Simple in-memory lock after repeated wrong passwords (per email).
const fails = new Map<string, { n: number; until: number }>();
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

function ipAllowed(list: string, ip?: string) {
  const entries = list.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (!entries.length || !ip) return true;
  const clean = ip.replace(/^::ffff:/, '');
  const toNum = (a: string) => a.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  return entries.some((e) => {
    const [base, bits] = e.split('/');
    if (!bits) return base === clean;
    const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (toNum(base) & mask) === (toNum(clean) & mask);
  });
}

async function permsFor(role: string) {
  if (role === 'Super Admin') return ['*'];
  const row = await db.query.rolePermissions.findFirst({ where: eq(rolePermissions.role, role) });
  return row?.modules ?? [];
}

/** Email + password login for the admin panel (no OTP). */
router.post('/login', authLimiter, ah(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email('Enter a valid email address'), password: z.string().min(1, 'Password is required') }), req.body);
  const key = email.toLowerCase();
  const f = fails.get(key);
  if (f && f.until > Date.now()) throw tooMany(`Too many wrong attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60_000)} minutes.`);

  const admin = await db.query.admins.findFirst({ where: eq(admins.email, key) });
  const ok = admin?.passwordHash ? await bcrypt.compare(password, admin.passwordHash) : false;
  if (!admin || !ok) {
    const n = (f && f.until <= Date.now() ? 0 : f?.n ?? 0) + 1;
    fails.set(key, { n, until: n >= LOCK_AFTER ? Date.now() + LOCK_MS : 0 });
    throw unauthorized('Incorrect email or password');
  }
  if (admin.status === 'DISABLED') throw forbidden('This admin account is disabled. Ask a Super Admin to enable it.');
  if (admin.status === 'INVITED') throw forbidden('Please accept your invite email and set a password first.');
  const security = await getSetting<{ ipAllowlist?: string }>('security', {});
  if (!ipAllowed(security.ipAllowlist ?? '', req.ip)) throw forbidden('Admin login is not allowed from this network.');

  fails.delete(key);
  await db.update(admins).set({ lastActiveAt: new Date() }).where(eq(admins.id, admin.id));
  req.admin = admin;
  await audit(req, 'Admin Team', 'Logged in', admin.email);
  res.json({ ...(await issueTokens(req, 'admin', admin.id, admin.role)), admin: adminPublic(admin), permissions: await permsFor(admin.role) });
}));

router.post('/refresh', ah(async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
  const { ownerId } = await rotate(req, refreshToken, 'admin');
  const admin = await db.query.admins.findFirst({ where: eq(admins.id, ownerId) });
  if (!admin || admin.status !== 'ACTIVE') throw unauthorized();
  res.json(await issueTokens(req, 'admin', admin.id, admin.role));
}));

router.post('/logout', ah(async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().optional() }), req.body ?? {});
  if (refreshToken) await revoke(refreshToken);
  res.json({ ok: true });
}));

router.get('/me', requireAdmin, ah(async (req, res) => {
  const sec = await getSetting<{ sessionTimeoutMin?: number }>('security', {});
  res.json({ admin: adminPublic(req.admin!), permissions: await permsFor(req.admin!.role), sessionTimeoutMin: sec.sessionTimeoutMin ?? 60 });
}));

router.post('/change-password', requireAdmin, ah(async (req, res) => {
  const { current, next } = parse(z.object({ current: z.string().min(1), next: z.string().min(8, 'Use at least 8 characters') }), req.body);
  const admin = req.admin!;
  if (!admin.passwordHash || !(await bcrypt.compare(current, admin.passwordHash))) throw badRequest('Current password is wrong');
  await db.update(admins).set({ passwordHash: await bcrypt.hash(next, 10) }).where(eq(admins.id, admin.id));
  await revokeAllFor('admin', admin.id);
  await audit(req, 'Admin Team', 'Changed own password', admin.email);
  res.json({ ok: true, message: 'Password changed. Please log in again on other devices.' });
}));

/** Invited admin sets a password using the link from the invite email. */
router.post('/accept-invite', authLimiter, ah(async (req, res) => {
  const { token, password, name } = parse(z.object({ token: z.string().min(20), password: z.string().min(8, 'Use at least 8 characters'), name: z.string().max(80).optional() }), req.body);
  const admin = await db.query.admins.findFirst({ where: and(eq(admins.inviteToken, token), gt(admins.inviteExpiry, new Date())) });
  if (!admin || admin.status !== 'INVITED') throw badRequest('This invite link is invalid or has expired. Ask for a new invite.');
  const [updated] = await db.update(admins).set({ passwordHash: await bcrypt.hash(password, 10), status: 'ACTIVE', inviteToken: null, inviteExpiry: null, name: name?.trim() || admin.name, lastActiveAt: new Date() }).where(eq(admins.id, admin.id)).returning();
  req.admin = updated;
  await audit(req, 'Admin Team', 'Accepted invite', updated.email);
  res.json({ ...(await issueTokens(req, 'admin', updated.id, updated.role)), admin: adminPublic(updated), permissions: await permsFor(updated.role) });
}));

export default router;
