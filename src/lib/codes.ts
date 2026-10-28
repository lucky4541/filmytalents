import { randomInt } from 'crypto';
import { desc, like } from 'drizzle-orm';
import { db, schema } from '../db';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const randomCode = (len = 8) => Array.from({ length: len }, () => ALPHA[randomInt(ALPHA.length)]).join('');

/** Next member code like CH50231. */
export async function nextMemberCode() {
  const [last] = await db.select({ code: schema.users.code }).from(schema.users).where(like(schema.users.code, 'CH%')).orderBy(desc(schema.users.code)).limit(1);
  const n = last ? Number(last.code.slice(2)) + 1 : 50001;
  return `CH${n}`;
}

/** Next casting code: CH-2042 for admin castings, MC-1042 for member castings. */
export async function nextCastingCode(prefix: 'CH' | 'MC') {
  const [last] = await db.select({ code: schema.castings.code }).from(schema.castings).where(like(schema.castings.code, `${prefix}-%`)).orderBy(desc(schema.castings.code)).limit(1);
  const n = last ? Number(last.code.split('-')[1]) + 1 : prefix === 'CH' ? 2001 : 1001;
  return `${prefix}-${n}`;
}

/** Indian mobile in E.164 form (+91XXXXXXXXXX) or null if invalid. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? `+91${ten}` : null;
}
export const maskPhone = (p: string) => `${p.slice(0, 3)} ${p.slice(3, 5)}•••••${p.slice(-3)}`;
