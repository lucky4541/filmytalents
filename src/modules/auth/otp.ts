import { randomInt } from 'crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../../db';
import { env, isProd } from '../../config/env';
import { hmacSha256, safeEqual } from '../../lib/crypto';
import { badRequest, tooMany } from '../../lib/errors';
import { provider, sendOtpSms } from '../../lib/sms';

const { otpCodes } = schema;
type Purpose = 'LOGIN' | 'CHANGE_PHONE' | 'REGISTER' | 'RESET_PASSWORD';
const MAX_ATTEMPTS = 5;

const hashCode = (phone: string, code: string) => hmacSha256(env.JWT_REFRESH_SECRET, `${phone}:${code}`);

/** Creates and sends a one-time code. Enforces resend wait and daily limit. */
export async function sendOtp(phone: string, purpose: Purpose, ip?: string) {
  const last = await db.query.otpCodes.findFirst({ where: and(eq(otpCodes.phone, phone), eq(otpCodes.purpose, purpose)), orderBy: desc(otpCodes.createdAt) });
  if (last) {
    const wait = Math.ceil((last.createdAt.getTime() + env.OTP_RESEND_SECONDS * 1000 - Date.now()) / 1000);
    if (wait > 0) throw tooMany(`Please wait ${wait} seconds before asking for a new code`);
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(otpCodes).where(and(eq(otpCodes.phone, phone), gt(otpCodes.createdAt, new Date(Date.now() - 86_400_000))));
  if (n >= env.OTP_MAX_PER_DAY) throw tooMany('Too many codes requested today. Please try again tomorrow or contact support.');

  const dummy = (await provider()) === 'dummy';
  const code = dummy ? env.DUMMY_OTP_CODE : String(randomInt(10 ** (env.OTP_LENGTH - 1), 10 ** env.OTP_LENGTH));
  const result = await sendOtpSms(phone, code);
  if (!result.ok) throw badRequest(`We couldn’t send the SMS right now (${result.error ?? 'unknown error'}). Please try again.`);

  // Older unused codes stop working once a new one is sent.
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(and(eq(otpCodes.phone, phone), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt)));
  await db.insert(otpCodes).values({ phone, purpose, codeHash: hashCode(phone, code), expiresAt: new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60_000), ip, provider: result.provider });

  return {
    sent: true,
    provider: result.provider,
    expiresIn: env.OTP_EXPIRY_MINUTES * 60,
    resendIn: env.OTP_RESEND_SECONDS,
    length: dummy ? env.DUMMY_OTP_CODE.length : env.OTP_LENGTH,
    // Only in dummy mode outside production, so testers know what to type.
    ...(dummy && !isProd ? { devHint: `Dummy mode: use ${env.DUMMY_OTP_CODE}` } : {}),
  };
}

/** Checks a code. Throws a friendly error when wrong, expired or tried too often. */
export async function verifyOtp(phone: string, code: string, purpose: Purpose) {
  const row = await db.query.otpCodes.findFirst({ where: and(eq(otpCodes.phone, phone), eq(otpCodes.purpose, purpose), isNull(otpCodes.consumedAt)), orderBy: desc(otpCodes.createdAt) });
  if (!row) throw badRequest('Please request a new code');
  if (row.expiresAt < new Date()) throw badRequest('This code has expired. Please request a new one.');
  if (row.attempts >= MAX_ATTEMPTS) throw tooMany('Too many wrong tries. Please request a new code.');
  if (!safeEqual(row.codeHash, hashCode(phone, code.trim()))) {
    await db.update(otpCodes).set({ attempts: row.attempts + 1 }).where(eq(otpCodes.id, row.id));
    const left = MAX_ATTEMPTS - row.attempts - 1;
    throw badRequest(left > 0 ? `Wrong code. ${left} tr${left === 1 ? 'y' : 'ies'} left.` : 'Too many wrong tries. Please request a new code.');
  }
  await db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, row.id));
}
