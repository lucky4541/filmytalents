import type { Admin, User } from '../db/schema';
import { isPaid } from '../middleware/auth';
import { maskPhone } from './codes';

/** The logged-in member's own account. */
export function meUser(u: User) {
  return {
    id: u.id, code: u.code, phone: u.phone, hasPassword: !!u.passwordHash, name: u.name, email: u.email, gender: u.gender, dob: u.dob, city: u.city, state: u.state, bio: u.bio,
    crafts: u.crafts, languages: u.languages, skills: u.skills, experience: u.experience, heightCm: u.heightCm,
    avatarUrl: u.avatarUrl, coverUrl: u.coverUrl, instagram: u.instagram, youtube: u.youtube,
    isMinor: u.isMinor, guardian: u.isMinor ? { name: u.guardianName, relation: u.guardianRelation, phone: u.guardianPhone, consentAt: u.guardianConsentAt } : null,
    verified: u.verified, status: u.status,
    plan: { id: u.planId, cycle: u.planCycle, until: u.planUntil, autoRenew: u.autoRenew, isPaid: isPaid(u) },
    applicationsThisMonth: u.applicationsMonth === monthKey() ? u.applicationsCount : 0,
    referralCode: u.referralCode, bonusDays: u.bonusDays, prefs: u.prefs, privacy: u.privacy, profileViews: u.profileViews,
    chatMutedUntil: u.chatMutedUntil, deletionRequestedAt: u.deletionRequestedAt, createdAt: u.createdAt,
    profileComplete: profileCompletion(u),
  };
}

/** What other members and visitors can see. Phone numbers are never included. */
export function publicUser(u: User) {
  const priv = (u.privacy ?? {}) as Record<string, boolean>;
  return {
    id: u.id, code: u.code, name: u.name, gender: u.gender, city: priv.showCity === false ? null : u.city, state: priv.showCity === false ? null : u.state,
    age: priv.showAge === false || !u.dob ? null : ageFrom(u.dob), bio: u.bio, crafts: u.crafts, languages: u.languages, skills: u.skills,
    experience: u.experience, heightCm: u.heightCm, avatarUrl: u.avatarUrl, coverUrl: u.coverUrl, instagram: u.instagram, youtube: u.youtube,
    verified: u.verified, isPro: isPaid(u), isMinor: u.isMinor, joinedAt: u.createdAt,
  };
}

/** Admin view of a member. */
export function adminUser(u: User) {
  const { phone: _phone, guardian, ...rest } = meUser(u);
  return { ...rest, guardian: guardian ? { ...guardian, phone: guardian.phone ? maskPhone(guardian.phone) : null } : null, phoneMasked: maskPhone(u.phone), suspendedUntil: u.suspendedUntil, warnings: u.warnings, lastActiveAt: u.lastActiveAt, referredById: u.referredById };
}

export function adminPublic(a: Admin) {
  return { id: a.id, name: a.name, email: a.email, role: a.role, status: a.status, lastActiveAt: a.lastActiveAt, createdAt: a.createdAt };
}

export const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
export function ageFrom(dob: Date) {
  const n = new Date();
  let a = n.getFullYear() - dob.getFullYear();
  if (n.getMonth() < dob.getMonth() || (n.getMonth() === dob.getMonth() && n.getDate() < dob.getDate())) a--;
  return a;
}
export function profileCompletion(u: User) {
  const checks = [!!u.name, !!u.avatarUrl, !!u.city, u.crafts.length > 0, u.languages.length > 0, !!u.bio, !!u.heightCm, !!u.dob, !!u.gender];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}
