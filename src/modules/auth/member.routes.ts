import { Router } from 'express';
import { and, eq, ne, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, parse } from '../../lib/http';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { normalizePhone, nextMemberCode, randomCode } from '../../lib/codes';
import { getSetting } from '../../lib/settings';
import { meUser } from '../../lib/serialize';
import { requireMember } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import { sendOtp, verifyOtp } from './otp';
import { issueTokens, revoke, revokeAllFor, rotate } from './tokens';

const { users } = schema;
const router = Router();

const phoneField = z.string({ required_error: 'Enter your mobile number' }).max(20).transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid 10-digit Indian mobile number' });
  return p ?? '';
});

const passwordField = z.string({ required_error: 'Choose a password' })
  .min(8, 'Use at least 8 characters')
  .max(72, 'Use at most 72 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Use letters and at least one number');
const codeField = z.string().regex(/^\d{4,6}$/, 'Enter the code from the SMS');

const newMemberDefaults = {
  prefs: { whatsapp: true, push: true, email: true, sms: false, newCastings: true, appUpdates: true, offers: false, weeklyDigest: true },
  privacy: { showInSearch: true, showAge: true, showCity: true },
};

/** A member whose account is closed can't log in or register again with that number. */
function assertOpen(u: { status: string } | undefined) {
  if (u?.status === 'BANNED' || u?.status === 'DELETED') throw forbidden('This account has been closed. Contact support if you think this is a mistake.');
}

/** Logging in again cancels a pending account deletion. */
async function touchLogin(userId: string) {
  const [u] = await db.update(users).set({ lastActiveAt: new Date(), deletionRequestedAt: null }).where(eq(users.id, userId)).returning();
  await db.update(schema.dataRequests).set({ status: 'cancelled', handledAt: new Date() })
    .where(and(eq(schema.dataRequests.userId, userId), eq(schema.dataRequests.type, 'delete'), eq(schema.dataRequests.status, 'pending')));
  return u;
}

/* ---------------- Registration: verify the number by OTP, then set a password ---------------- */

/** Step 1 of sign-up: send a code to confirm the number is theirs. */
router.post('/register/otp', authLimiter, ah(async (req, res) => {
  const { phone } = parse(z.object({ phone: phoneField }), req.body);
  const existing = await db.query.users.findFirst({ where: eq(users.phone, phone), columns: { id: true, status: true, passwordHash: true } });
  assertOpen(existing);
  if (existing?.passwordHash) throw conflict('This number is already registered. Log in, or use “Forgot password”.');
  const features = await getSetting<{ signups?: boolean }>('features', {});
  if (!existing && features.signups === false) throw forbidden('New sign-ups are paused right now. Please try again later.');
  const r = await sendOtp(phone, 'REGISTER', req.ip);
  res.json({ ...r, phone });
}));

/** Step 2 of sign-up: check the code, create the account with the password, and log in. */
router.post('/register', authLimiter, ah(async (req, res) => {
  const b = parse(z.object({
    phone: phoneField, code: codeField, password: passwordField,
    name: z.string().trim().max(80).optional(), email: z.string().trim().email('Enter a valid email').max(120).optional().or(z.literal('')),
    referralCode: z.string().max(20).optional(),
  }), req.body);
  const existing = await db.query.users.findFirst({ where: eq(users.phone, b.phone) });
  assertOpen(existing);
  if (existing?.passwordHash) throw conflict('This number is already registered. Log in, or use “Forgot password”.');
  await verifyOtp(b.phone, b.code, 'REGISTER');

  const passwordHash = await bcrypt.hash(b.password, 10);
  let user;
  if (existing) {
    // Account made before passwords existed: confirm the number and set the password.
    [user] = await db.update(users).set({ passwordHash, passwordSetAt: new Date(), phoneVerifiedAt: existing.phoneVerifiedAt ?? new Date(), name: existing.name || b.name || '', email: existing.email || b.email || null }).where(eq(users.id, existing.id)).returning();
  } else {
    const referrer = b.referralCode ? await db.query.users.findFirst({ where: eq(users.referralCode, b.referralCode.toUpperCase()), columns: { id: true } }) : undefined;
    [user] = await db.insert(users).values({
      code: await nextMemberCode(), phone: b.phone, phoneVerifiedAt: new Date(), passwordHash, passwordSetAt: new Date(),
      name: b.name ?? '', email: b.email || null, referralCode: randomCode(8), referredById: referrer?.id ?? null, ...newMemberDefaults,
    }).returning();
  }
  const tokens = await issueTokens(req, 'member', user.id);
  res.status(201).json({ ...tokens, isNewUser: !existing, user: meUser(user) });
}));

/* ---------------- Login: mobile number, member ID or email + password ---------------- */

async function findByIdentifier(raw: string) {
  const v = raw.trim();
  const phone = normalizePhone(v);
  if (phone) return db.query.users.findFirst({ where: eq(users.phone, phone) });
  if (/^CH\d{4,}$/i.test(v)) return db.query.users.findFirst({ where: eq(users.code, v.toUpperCase()) });
  if (v.includes('@')) {
    // Email isn't unique across members, so it only works when exactly one account uses it.
    const rows = await db.select().from(users).where(and(sql`lower(${users.email}) = ${v.toLowerCase()}`, ne(users.status, 'DELETED'))).limit(2);
    return rows.length === 1 ? rows[0] : undefined;
  }
  return undefined;
}

const WRONG = 'Wrong mobile number / member ID or password';
// Spend the same time on unknown accounts so response time doesn't reveal which numbers are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-0', 10);

router.post('/login', authLimiter, ah(async (req, res) => {
  const b = parse(z.object({ identifier: z.string({ required_error: 'Enter your mobile number or member ID' }).trim().min(3, 'Enter your mobile number or member ID').max(120), password: z.string({ required_error: 'Enter your password' }).min(1, 'Enter your password').max(72) }), req.body);
  const user = await findByIdentifier(b.identifier);
  const ok = await bcrypt.compare(b.password, user?.passwordHash ?? DUMMY_HASH);
  if (user && !user.passwordHash) throw badRequest('This account doesn’t have a password yet. Tap “Forgot password” to set one with an OTP.');
  if (!user || !ok) throw badRequest(WRONG);
  assertOpen(user);
  const u = await touchLogin(user.id);
  const tokens = await issueTokens(req, 'member', user.id);
  res.json({ ...tokens, isNewUser: false, user: meUser(u) });
}));

/* ---------------- Forgot password: OTP to the registered number ---------------- */

router.post('/password/otp', authLimiter, ah(async (req, res) => {
  const { phone } = parse(z.object({ phone: phoneField }), req.body);
  const user = await db.query.users.findFirst({ where: eq(users.phone, phone), columns: { id: true, status: true } });
  if (!user) throw notFound('Account with this number');
  assertOpen(user);
  res.json({ ...(await sendOtp(phone, 'RESET_PASSWORD', req.ip)), phone });
}));

router.post('/password/reset', authLimiter, ah(async (req, res) => {
  const b = parse(z.object({ phone: phoneField, code: codeField, password: passwordField }), req.body);
  const user = await db.query.users.findFirst({ where: eq(users.phone, b.phone) });
  if (!user) throw notFound('Account with this number');
  assertOpen(user);
  await verifyOtp(b.phone, b.code, 'RESET_PASSWORD');
  await db.update(users).set({ passwordHash: await bcrypt.hash(b.password, 10), passwordSetAt: new Date(), phoneVerifiedAt: user.phoneVerifiedAt ?? new Date() }).where(eq(users.id, user.id));
  // A new password signs out every other device.
  await revokeAllFor('member', user.id);
  const u = await touchLogin(user.id);
  const tokens = await issueTokens(req, 'member', user.id);
  res.json({ ...tokens, isNewUser: false, user: meUser(u) });
}));

/** Change password while logged in. */
router.post('/password/change', requireMember, ah(async (req, res) => {
  const b = parse(z.object({ current: z.string().max(72).optional(), password: passwordField }), req.body);
  const user = (await db.query.users.findFirst({ where: eq(users.id, req.user!.id) }))!;
  if (user.passwordHash && !(await bcrypt.compare(b.current ?? '', user.passwordHash))) throw badRequest('Current password is wrong');
  await db.update(users).set({ passwordHash: await bcrypt.hash(b.password, 10), passwordSetAt: new Date() }).where(eq(users.id, user.id));
  await revokeAllFor('member', user.id);
  res.json({ ...(await issueTokens(req, 'member', user.id)), ok: true });
}));

router.post('/refresh', ah(async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20) }), req.body);
  const { ownerId } = await rotate(req, refreshToken, 'member');
  const user = await db.query.users.findFirst({ where: eq(users.id, ownerId) });
  if (!user || user.status === 'BANNED' || user.status === 'DELETED') throw badRequest('Please log in again');
  res.json(await issueTokens(req, 'member', ownerId));
}));

router.post('/logout', ah(async (req, res) => {
  const { refreshToken, all } = parse(z.object({ refreshToken: z.string().optional(), all: z.boolean().optional() }), req.body ?? {});
  if (refreshToken) await revoke(refreshToken);
  if (all && req.headers.authorization) {
    await new Promise<void>((resolve, reject) => requireMember(req, res, (e?: unknown) => (e ? reject(e) : resolve())));
    if (req.user) await revokeAllFor('member', req.user.id);
  }
  res.json({ ok: true });
}));

router.get('/me', requireMember, ah(async (req, res) => {
  res.json({ user: meUser(req.user!) });
}));

export default router;
