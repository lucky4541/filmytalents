import { and, count, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import type { Application, Casting, CastingRole, User } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { getSetting } from '../../lib/settings';
import { notifyRule } from '../../lib/notify';
import { publicUser, monthKey } from '../../lib/serialize';
import { maskPhone } from '../../lib/codes';
import { isPaid } from '../../middleware/auth';

const { castings, castingRoles, applications, users } = schema;

/* ---------------------------- Input ---------------------------- */

export const roleInput = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2, 'Role name is too short').max(80),
  gender: z.enum(['Male', 'Female', 'Any']).default('Any'),
  ageMin: z.coerce.number().int().min(0).max(100).default(18),
  ageMax: z.coerce.number().int().min(0).max(100).default(60),
  positions: z.coerce.number().int().min(1).max(500).default(1),
  heightNote: z.string().max(80).default(''),
  skills: z.array(z.string().trim().max(40)).max(15).default([]),
  experience: z.string().max(30).default('Any'),
}).refine((r) => r.ageMin <= r.ageMax, 'Minimum age must be less than maximum age');

export const castingInput = z.object({
  title: z.string().trim().min(5, 'Title is too short').max(140),
  production: z.string().trim().min(2).max(120),
  showProductionAs: z.enum(['name', 'confidential']).default('name'),
  projectType: z.string().trim().min(2).max(60),
  posterUrl: z.string().url().max(500).nullable().optional(),
  description: z.string().trim().min(20, 'Describe the project in at least 20 characters').max(5000),
  location: z.string().trim().min(2).max(80),
  mode: z.enum(['In person', 'Online', 'Self tape']).default('In person'),
  venue: z.string().trim().max(200).default(''),
  languages: z.array(z.string().trim().max(30)).max(10).default([]),
  budget: z.string().trim().max(80).default(''),
  deadline: z.coerce.date(),
  roles: z.array(roleInput).min(1, 'Add at least one role').max(20),
});

/* ---------------------------- Safety ---------------------------- */

const DEFAULT_BLOCKED = ['registration fee', 'registration charge', 'pay first', 'advance payment', 'security deposit', 'gpay', 'google pay', 'phonepe', 'paytm', 'processing fee', 'portfolio fee', 'pay to audition'];

/** Castings that ask talent for money are refused. Returns the words found. */
export async function moneyWords(text: string) {
  const chat = await getSetting<{ blockedWords?: string }>('chat', {});
  const extra = (chat.blockedWords ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  const t = text.toLowerCase();
  return [...new Set([...DEFAULT_BLOCKED, ...extra])].filter((w) => t.includes(w));
}

/** Phone numbers or emails in a member casting would let posters skip the platform. */
export const hasContactInfo = (text: string) => /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/.test(text) || /[\w.+-]+@[\w-]+\.[\w.]+/.test(text);

export async function assertSafeCasting(input: { title: string; description: string; budget?: string }, member: boolean) {
  const text = `${input.title}\n${input.description}\n${input.budget ?? ''}`;
  const found = await moneyWords(text);
  if (found.length) throw badRequest(`Castings can’t ask talent for money. Remove: ${found.join(', ')}`, { blockedWords: found });
  if (member && hasContactInfo(text)) throw badRequest('Don’t add phone numbers or emails. Talent applies through the app, and you see the phone number of anyone you select.');
}

/* ---------------------------- Lifecycle ---------------------------- */

/** Scheduled castings whose time has come go live. Called before listings (cheap UPDATE). */
export async function publishDue() {
  await db.update(castings).set({ status: 'LIVE', publishedAt: sql`coalesce(${castings.publishAt}, now())` })
    .where(and(eq(castings.status, 'SCHEDULED'), lte(castings.publishAt, new Date())));
}

export const isOpen = (c: Casting) => c.status === 'LIVE' && c.deadline > new Date();

/** Until when Free members can't see / apply (Pro early access). */
export const earlyUntil = (c: Casting) => (c.proEarlyAccessHours > 0 && c.publishedAt ? new Date(c.publishedAt.getTime() + c.proEarlyAccessHours * 3_600_000) : null);

export async function saveRoles(castingId: string, roles: z.infer<typeof roleInput>[]) {
  const existing = await db.select().from(castingRoles).where(eq(castingRoles.castingId, castingId));
  const keep = new Set(roles.map((r) => r.id).filter(Boolean));
  for (const r of existing) {
    if (keep.has(r.id)) continue;
    const [{ n }] = await db.select({ n: count() }).from(applications).where(eq(applications.roleId, r.id));
    if (n > 0) throw badRequest(`Role “${r.name}” already has applicants and can’t be removed`);
    await db.delete(castingRoles).where(eq(castingRoles.id, r.id));
  }
  for (const r of roles) {
    const { id, ...data } = r;
    if (id && existing.some((e) => e.id === id)) await db.update(castingRoles).set(data).where(eq(castingRoles.id, id));
    else await db.insert(castingRoles).values({ ...data, castingId });
  }
}

/* ---------------------------- Output ---------------------------- */

export async function rolesFor(ids: string[]) {
  if (!ids.length) return new Map<string, CastingRole[]>();
  const rows = await db.select().from(castingRoles).where(inArray(castingRoles.castingId, ids));
  const m = new Map<string, CastingRole[]>();
  for (const r of rows) m.set(r.castingId, [...(m.get(r.castingId) ?? []), r]);
  return m;
}

export async function applicantCounts(ids: string[]) {
  if (!ids.length) return new Map<string, Record<string, number>>();
  const rows = await db.select({ castingId: applications.castingId, status: applications.status, n: count() }).from(applications).where(inArray(applications.castingId, ids)).groupBy(applications.castingId, applications.status);
  const m = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const o = m.get(r.castingId) ?? { total: 0 };
    o[r.status] = r.n;
    o.total += r.n;
    m.set(r.castingId, o);
  }
  return m;
}

/** What members and visitors see. */
export function publicCasting(c: Casting, roles: CastingRole[], viewer?: User | null) {
  const early = earlyUntil(c);
  const pro = !!viewer && isPaid(viewer);
  const lockedEarly = !!early && early > new Date() && !pro;
  return {
    id: c.id, code: c.code, title: c.title,
    production: c.showProductionAs === 'confidential' ? 'Confidential production' : c.production,
    projectType: c.projectType, posterUrl: c.posterUrl, description: c.description, location: c.location, mode: c.mode,
    venue: c.venue, languages: c.languages, budget: c.budget, deadline: c.deadline, publishedAt: c.publishedAt,
    visibility: c.visibility, proOnly: c.visibility === 'PRO', featured: c.featured, urgent: c.urgent, views: c.views,
    postedBy: c.postedByUserId ? 'member' : 'casting-hub',
    open: isOpen(c), earlyAccessUntil: early, lockedForFree: lockedEarly,
    roles: roles.map((r) => ({ id: r.id, name: r.name, gender: r.gender, ageMin: r.ageMin, ageMax: r.ageMax, positions: r.positions, heightNote: r.heightNote, skills: r.skills, experience: r.experience })),
  };
}

/**
 * An applicant as the casting owner sees them.
 * Phone: admins see it masked; a member poster sees the real number only once they mark the applicant SELECTED.
 */
export function applicantView(a: Application, u: User, role: CastingRole | undefined, who: 'admin' | 'poster', extra: Record<string, unknown> = {}) {
  const phoneVisible = who === 'poster' && a.status === 'SELECTED';
  const contact = u.isMinor ? u.guardianPhone : u.phone;
  return {
    id: a.id, status: a.status, rating: a.rating, note: a.note, tapeUrl: a.tapeUrl, appliedAt: a.createdAt, updatedAt: a.updatedAt,
    role: role ? { id: role.id, name: role.name } : null,
    talent: { ...publicUser(u), heightCm: u.heightCm, isMinor: u.isMinor },
    phone: phoneVisible ? contact : null,
    phoneMasked: contact ? maskPhone(contact) : null,
    contactIsGuardian: u.isMinor,
    ...extra,
  };
}

/* ---------------------------- Applying ---------------------------- */

/** Free plan limit (from Admin → Plans). null = unlimited. */
export async function monthlyLimit(u: User) {
  if (isPaid(u)) {
    const plan = await db.query.plans.findFirst({ where: eq(schema.plans.id, u.planId) });
    return plan?.limits.applicationsPerMonth ?? null;
  }
  const free = await db.query.plans.findFirst({ where: eq(schema.plans.id, 'free') });
  return free?.limits.applicationsPerMonth ?? 5;
}

export async function usedThisMonth(u: User) {
  return u.applicationsMonth === monthKey() ? u.applicationsCount : 0;
}

export async function countApplication(u: User) {
  const mk = monthKey();
  await db.update(users).set(u.applicationsMonth === mk ? { applicationsCount: sql`${users.applicationsCount} + 1` } : { applicationsMonth: mk, applicationsCount: 1 }).where(eq(users.id, u.id));
}

/* ---------------------------- Pipeline ---------------------------- */

export const PIPELINE = ['APPLIED', 'VIEWED', 'SHORTLISTED', 'ROUND2', 'SELECTED', 'REJECTED'] as const;
export type AppStatus = (typeof PIPELINE)[number];

/** Changes applicant status and sends the matching Auto-message. */
export async function setStatus(appIds: string[], status: AppStatus) {
  if (!appIds.length) return [];
  const rows = await db.select({ a: applications, c: castings, r: castingRoles }).from(applications)
    .innerJoin(castings, eq(castings.id, applications.castingId)).innerJoin(castingRoles, eq(castingRoles.id, applications.roleId))
    .where(inArray(applications.id, appIds));
  if (!rows.length) throw notFound('Applicant');
  const changed = rows.filter((x) => x.a.status !== status);
  if (!changed.length) return rows.map((x) => x.a);
  const updated = await db.update(applications).set({ status }).where(inArray(applications.id, changed.map((x) => x.a.id))).returning();
  const rule = { SHORTLISTED: 'shortlisted', SELECTED: 'selected', REJECTED: 'not_selected' }[status as string];
  if (rule) for (const x of changed) await notifyRule(rule, x.a.userId, { role: x.r.name, casting: x.c.title }, '/my-applications');
  return updated;
}
