import { z } from 'zod';
import { normalizePhone } from '../../lib/codes';

export const phoneField = z.string({ required_error: 'Enter a mobile number' }).max(20).transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid 10-digit Indian mobile number' });
  return p ?? '';
});

const list = (max = 20) => z.array(z.string().trim().min(1).max(40)).max(max);
const url = z.string().trim().max(200).url('Enter a full link starting with https://').or(z.literal('')).nullable();

/** Fields a member can edit on their own profile. */
export const profileSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(120).or(z.literal('')).nullable(),
  gender: z.enum(['Male', 'Female', 'Other']).nullable(),
  dob: z.coerce.date().refine((d) => d < new Date() && d.getFullYear() > 1920, 'Enter a valid date of birth').nullable(),
  city: z.string().trim().max(60).nullable(),
  state: z.string().trim().max(60).nullable(),
  bio: z.string().trim().max(1000),
  crafts: list(6),
  languages: list(10),
  skills: list(20),
  experience: z.string().trim().max(30).nullable(),
  heightCm: z.coerce.number().int().min(50).max(250).nullable(),
  instagram: url,
  youtube: url,
  guardianName: z.string().trim().max(80).nullable(),
  guardianRelation: z.string().trim().max(40).nullable(),
  guardianPhone: phoneField.nullable(),
  guardianConsent: z.boolean(),
}).partial();

export const PREF_KEYS = ['castingAlerts', 'applicationUpdates', 'messages', 'offers', 'sms', 'whatsapp', 'email', 'push', 'weeklyDigest'] as const;
export const PRIVACY_KEYS = ['showAge', 'showCity', 'hideFromSearch', 'allowMessages', 'showOnline'] as const;
export const flagsSchema = (keys: readonly string[]) => z.record(z.boolean()).refine((o) => Object.keys(o).every((k) => keys.includes(k)), `Allowed keys: ${keys.join(', ')}`);
