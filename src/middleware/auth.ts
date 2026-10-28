import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import type { Admin, User } from '../db/schema';
import { verifyAccess } from '../lib/jwt';
import { forbidden, paymentRequired, unauthorized } from '../lib/errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      admin?: Admin;
    }
  }
}

const { users, admins, rolePermissions } = schema;

function bearer(req: Request) {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

async function setUser(id: string, data: Partial<User>) {
  const [u] = await db.update(users).set(data).where(eq(users.id, id)).returning();
  return u;
}

async function loadMember(req: Request): Promise<User | null> {
  const token = bearer(req);
  if (!token) return null;
  let p;
  try { p = verifyAccess(token); } catch { throw unauthorized('Your session expired. Please log in again.'); }
  if (p.kind !== 'member') throw unauthorized();
  const user = await db.query.users.findFirst({ where: eq(users.id, p.sub) });
  if (!user || user.status === 'DELETED') throw unauthorized();
  if (user.status === 'BANNED') throw forbidden('This account has been closed.');
  if (user.status === 'SUSPENDED') {
    if (user.suspendedUntil && user.suspendedUntil < new Date()) return setUser(user.id, { status: 'ACTIVE', suspendedUntil: null });
    throw forbidden(`Your account is suspended${user.suspendedUntil ? ` until ${user.suspendedUntil.toDateString()}` : ''}.`);
  }
  // Paid plan ended → back to Free.
  if (user.planId !== 'free' && user.planUntil && user.planUntil < new Date()) return setUser(user.id, { planId: 'free', planCycle: null });
  return user;
}

/** Requires a logged-in member. */
export async function requireMember(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await loadMember(req);
    if (!user) throw unauthorized();
    req.user = user;
    if (Date.now() - user.lastActiveAt.getTime() > 5 * 60_000) void db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, user.id)).catch(() => undefined);
    next();
  } catch (e) { next(e); }
}

/** Adds req.user when a valid token is sent; continues as a visitor otherwise. */
export async function optionalMember(req: Request, _res: Response, next: NextFunction) {
  try { req.user = (await loadMember(req)) ?? undefined; } catch { req.user = undefined; }
  next();
}

export const isPaid = (u: Pick<User, 'planId' | 'planUntil'>) => u.planId !== 'free' && (!u.planUntil || u.planUntil > new Date());

/** Requires a paid (Pro) plan. Use after requireMember. */
export function requirePro(feature: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !isPaid(req.user)) return next(paymentRequired(`${feature} is for Pro members. Upgrade to continue.`));
    next();
  };
}

/* ---------- Per-plan features (Admin → Plans) ---------- */
export type PlanFeature = 'chat' | 'postCastings' | 'videoPosts' | 'whoViewed';
let planCache: { at: number; map: Map<string, Record<string, unknown>> } | null = null;
export const clearPlanCache = () => { planCache = null; };

/** True when the member's current plan includes the feature. An expired paid plan counts as Free. */
export async function planAllows(u: Pick<User, 'planId' | 'planUntil'>, feature: PlanFeature) {
  if (!planCache || Date.now() - planCache.at > 30_000) {
    const rows = await db.select({ id: schema.plans.id, limits: schema.plans.limits }).from(schema.plans);
    planCache = { at: Date.now(), map: new Map(rows.map((r) => [r.id, r.limits as unknown as Record<string, unknown>])) };
  }
  const id = isPaid(u) ? u.planId : 'free';
  const limits = planCache.map.get(id);
  // Plans saved before per-plan features existed: every paid plan had every feature.
  if (!limits || limits[feature] === undefined) return id !== 'free';
  return limits[feature] === true;
}

/** Route guard for a plan feature. */
export function requireFeature(feature: PlanFeature, label: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(paymentRequired(`${label} needs a paid plan.`));
    planAllows(req.user, feature).then((ok) => next(ok ? undefined : paymentRequired(`${label} isn’t included in your plan. Upgrade to continue.`))).catch(next);
  };
}

/** Requires a logged-in admin. */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = bearer(req);
    if (!token) throw unauthorized();
    let p;
    try { p = verifyAccess(token); } catch { throw unauthorized('Your session expired. Please log in again.'); }
    if (p.kind !== 'admin') throw unauthorized();
    const admin = await db.query.admins.findFirst({ where: eq(admins.id, p.sub) });
    if (!admin || admin.status !== 'ACTIVE') throw unauthorized();
    req.admin = admin;
    if (!admin.lastActiveAt || Date.now() - admin.lastActiveAt.getTime() > 5 * 60_000) void db.update(admins).set({ lastActiveAt: new Date() }).where(eq(admins.id, admin.id)).catch(() => undefined);
    next();
  } catch (e) { next(e); }
}

let permCache: { at: number; map: Map<string, string[]> } | null = null;
export const clearPermCache = () => { permCache = null; };

async function permissionsFor(role: string) {
  if (!permCache || Date.now() - permCache.at > 60_000) {
    const rows = await db.select().from(rolePermissions);
    permCache = { at: Date.now(), map: new Map(rows.map((r) => [r.role, r.modules])) };
  }
  return permCache.map.get(role) ?? [];
}

/** Requires the admin's role to include one of these modules. Super Admin always passes. */
export function requirePerm(...modules: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const admin = req.admin;
      if (!admin) throw unauthorized();
      if (admin.role === 'Super Admin') return next();
      const mine = await permissionsFor(admin.role);
      if (!modules.some((m) => mine.includes(m))) throw forbidden(`Your role (${admin.role}) can’t open this area`);
      next();
    } catch (e) { next(e); }
  };
}
