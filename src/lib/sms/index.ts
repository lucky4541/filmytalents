import { env } from '../../config/env';
import { logger } from '../logger';
import { getSecret, getSetting } from '../settings';

export interface SmsResult { ok: boolean; provider: string; ref?: string; error?: string }

/** Indian 10-digit number from +91XXXXXXXXXX. */
const ten = (phone: string) => phone.replace(/\D/g, '').slice(-10);

export interface SmsSettings { provider?: 'dummy' | 'fast2sms'; route?: 'otp' | 'dlt' | 'q'; senderId?: string; templateId?: string }

/** SMS settings from Admin → Settings → SMS, falling back to .env. */
export async function smsConfig() {
  const s = await getSetting<SmsSettings>('sms', {});
  return {
    provider: s.provider ?? env.OTP_PROVIDER,
    route: s.route ?? env.FAST2SMS_ROUTE,
    senderId: s.senderId || env.FAST2SMS_SENDER_ID,
    templateId: s.templateId || env.FAST2SMS_DLT_TEMPLATE_ID,
  };
}

/** Picks the provider from settings (admin panel) or .env. */
export async function provider(): Promise<'dummy' | 'fast2sms'> {
  return (await smsConfig()).provider;
}

async function fast2smsKey() {
  return (await getSecret('fast2sms.apiKey')) ?? env.FAST2SMS_API_KEY;
}

async function fast2sms(body: Record<string, string>): Promise<SmsResult> {
  const key = await fast2smsKey();
  if (!key) return { ok: false, provider: 'fast2sms', error: 'FAST2SMS_API_KEY is not set' };
  try {
    const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: { authorization: key, 'Content-Type': 'application/json', 'cache-control': 'no-cache' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as { return?: boolean; request_id?: string; message?: string | string[] };
    if (!res.ok || !data.return) {
      const msg = Array.isArray(data.message) ? data.message.join(' ') : data.message ?? `HTTP ${res.status}`;
      logger.warn({ msg }, 'Fast2SMS rejected the request');
      return { ok: false, provider: 'fast2sms', error: msg };
    }
    return { ok: true, provider: 'fast2sms', ref: data.request_id };
  } catch (e) {
    logger.error({ err: e }, 'Fast2SMS request failed');
    return { ok: false, provider: 'fast2sms', error: 'SMS service did not respond' };
  }
}

/** Sends a login code. In dummy mode nothing is sent and the code is logged. */
export async function sendOtpSms(phone: string, code: string): Promise<SmsResult> {
  if ((await provider()) === 'dummy') {
    logger.info({ phone: `******${ten(phone).slice(-4)}` }, `[dummy SMS] OTP ${code}`);
    return { ok: true, provider: 'dummy' };
  }
  const cfg = await smsConfig();
  if (cfg.route === 'dlt') {
    return fast2sms({ route: 'dlt', sender_id: cfg.senderId, message: cfg.templateId, variables_values: code, numbers: ten(phone), flash: '0' });
  }
  // "otp" route: Fast2SMS sends "Your OTP is XXXX" — no DLT registration needed.
  return fast2sms({ route: 'otp', variables_values: code, numbers: ten(phone), flash: '0' });
}

/** Sends a plain text SMS (alerts). Uses the Quick SMS route. */
export async function sendTextSms(phone: string, message: string): Promise<SmsResult> {
  if ((await provider()) === 'dummy') {
    logger.info({ phone: `******${ten(phone).slice(-4)}` }, `[dummy SMS] ${message}`);
    return { ok: true, provider: 'dummy' };
  }
  return fast2sms({ route: 'q', message: message.slice(0, 300), numbers: ten(phone), flash: '0', language: 'english' });
}

/** Same text to many numbers (Fast2SMS takes up to ~200 comma-separated numbers per request). */
export async function sendBulkTextSms(phones: string[], message: string): Promise<{ sent: number; failed: number }> {
  const list = [...new Set(phones.map(ten).filter((p) => /^[6-9]\d{9}$/.test(p)))];
  if (!list.length) return { sent: 0, failed: 0 };
  if ((await provider()) === 'dummy') {
    logger.info({ count: list.length }, `[dummy SMS] bulk: ${message}`);
    return { sent: list.length, failed: 0 };
  }
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const r = await fast2sms({ route: 'q', message: message.slice(0, 300), numbers: chunk.join(','), flash: '0', language: 'english' });
    if (r.ok) sent += chunk.length; else failed += chunk.length;
  }
  return { sent, failed };
}

/** Wallet balance check used by the admin settings "Test SMS" button. */
export async function fast2smsBalance(): Promise<{ ok: boolean; balance?: number; error?: string }> {
  const key = await fast2smsKey();
  if (!key) return { ok: false, error: 'API key not set' };
  try {
    const res = await fetch('https://www.fast2sms.com/dev/wallet', { headers: { authorization: key }, signal: AbortSignal.timeout(10_000) });
    const data = (await res.json()) as { return?: boolean; wallet?: string; message?: string };
    return data.return ? { ok: true, balance: Number(data.wallet) } : { ok: false, error: data.message ?? 'Invalid key' };
  } catch {
    return { ok: false, error: 'Fast2SMS did not respond' };
  }
}
