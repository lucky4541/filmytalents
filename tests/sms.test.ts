import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Fast2SMS adapter', () => {
  // A key saved from the admin panel wins over .env, so start each test without one.
  beforeEach(async () => {
    const { db, schema } = await import('../src/db');
    const { eq } = await import('drizzle-orm');
    await db.delete(schema.secretSettings).where(eq(schema.secretSettings.key, 'fast2sms.apiKey'));
    await db.delete(schema.settings).where(eq(schema.settings.key, 'sms'));
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); process.env.OTP_PROVIDER = 'dummy'; });

  it('sends the OTP route with the 10-digit number and the API key header', async () => {
    process.env.OTP_PROVIDER = 'fast2sms';
    process.env.FAST2SMS_API_KEY = 'test-key-123';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ return: true, request_id: 'req_1', message: ['SMS sent successfully.'] }) });
    vi.stubGlobal('fetch', fetchMock);
    const { sendOtpSms } = await import('../src/lib/sms');
    const r = await sendOtpSms('+919876543210', '482913');
    expect(r).toMatchObject({ ok: true, provider: 'fast2sms', ref: 'req_1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.fast2sms.com/dev/bulkV2');
    expect(init.headers.authorization).toBe('test-key-123');
    expect(JSON.parse(init.body)).toMatchObject({ route: 'otp', variables_values: '482913', numbers: '9876543210' });
  });

  it('reports Fast2SMS errors instead of crashing', async () => {
    process.env.OTP_PROVIDER = 'fast2sms';
    process.env.FAST2SMS_API_KEY = 'bad';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ return: false, message: 'Invalid Authentication' }) }));
    const { sendOtpSms } = await import('../src/lib/sms');
    const r = await sendOtpSms('+919876543210', '111111');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid Authentication/);
  });
});
