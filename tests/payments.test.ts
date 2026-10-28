import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { api, auth, loginAdmin, loginMember } from './helpers';
import { db, schema } from '../src/db';
import { hmacSha256 } from '../src/lib/crypto';

let admin: Awaited<ReturnType<typeof loginAdmin>>;
const billing = { name: 'Ravi Kumar', email: 'ravi@example.com', state: 'Telangana' };

beforeAll(async () => { admin = await loginAdmin(); });

describe('plans & quote', () => {
  it('lists plans with prices in paise and available gateways', async () => {
    const r = await api().get('/api/v1/plans');
    const pro = r.body.items.find((p: { id: string }) => p.id === 'pro');
    expect(pro.prices.find((x: { cycle: string }) => x.cycle === 'MONTHLY').price).toBe(9900);
    expect(r.body.gateways).toContain('razorpay');
  });

  it('quotes GST: CGST+SGST in Telangana, IGST elsewhere, with coupon', async () => {
    const m = await loginMember();
    const t = await api().post('/api/v1/payments/quote').set(auth(m.token)).send({ planId: 'pro', cycle: 'YEARLY', state: 'Telangana' });
    expect(t.body).toMatchObject({ base: 99000, gst: 17820, amount: 116820 });
    expect(t.body.gstSplit).toEqual({ cgst: 8910, sgst: 8910, igst: 0 });
    const k = await api().post('/api/v1/payments/quote').set(auth(m.token)).send({ planId: 'pro', cycle: 'YEARLY', state: 'Karnataka', coupon: 'yearly15' });
    expect(k.body.discount).toBe(14850);
    expect(k.body.gstSplit.igst).toBe(k.body.gst);
    const bad = await api().post('/api/v1/payments/quote').set(auth(m.token)).send({ planId: 'pro', cycle: 'MONTHLY', coupon: 'YEARLY15' });
    expect(bad.body.couponError).toMatch(/yearly/);
  });
});

describe('checkout (mock gateway)', () => {
  it('order → verify → plan active, invoice, receipt', async () => {
    const m = await loginMember();
    const o = await api().post('/api/v1/payments/order').set(auth(m.token)).send({ planId: 'pro', cycle: 'MONTHLY', coupon: 'WELCOME20', billing });
    expect(o.status).toBe(201);
    expect(o.body.amount).toBe(Math.round(7920 * 1.18));
    expect(o.body.checkout.mock).toBe(true);
    const v = await api().post('/api/v1/payments/verify').set(auth(m.token)).send({ paymentId: o.body.paymentId, mock: 'success', method: 'UPI' });
    expect(v.body.status).toBe('SUCCESS');
    expect(v.body.payment.invoiceNo).toMatch(/^CH-INV-\d{4}-\d{2}\/\d{5}$/);
    const me = await api().get('/api/v1/me').set(auth(m.token));
    expect(me.body.user.plan.isPaid).toBe(true);
    const inv = await api().get(`/api/v1/payments/${o.body.paymentId}/invoice`).set(auth(m.token));
    expect(inv.text).toContain('CGST 9%');
    expect(inv.text).toContain('WELCOME20');
    // Second verify is a no-op (idempotent).
    expect((await api().post('/api/v1/payments/verify').set(auth(m.token)).send({ paymentId: o.body.paymentId, mock: 'success' })).body.status).toBe('SUCCESS');
    const n = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, m.user.id));
    expect(n.filter((x) => x.type === 'payment_receipt')).toHaveLength(1);
  });

  it('renewal extends from the current end date', async () => {
    const m = await loginMember();
    for (let i = 0; i < 2; i++) {
      const o = await api().post('/api/v1/payments/order').set(auth(m.token)).send({ planId: 'pro', cycle: 'MONTHLY', billing });
      await api().post('/api/v1/payments/verify').set(auth(m.token)).send({ paymentId: o.body.paymentId, mock: 'success' });
    }
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, m.user.id) });
    const days = (u!.planUntil!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(56);
  });

  it('failed payment suggests the other gateway', async () => {
    await api().put('/api/v1/admin/settings/payments').set(auth(admin.token)).send({ cashfree: { enabled: true } });
    const m = await loginMember();
    const o = await api().post('/api/v1/payments/order').set(auth(m.token)).send({ planId: 'pro', cycle: 'MONTHLY', billing });
    expect(o.body.fallback).toBe('cashfree');
    const f = await api().post(`/api/v1/payments/${o.body.paymentId}/failed`).set(auth(m.token)).send({ reason: 'UPI timed out' });
    expect(f.body.tryInstead).toBe('cashfree');
    const h = await api().get('/api/v1/payments').set(auth(m.token));
    expect(h.body.items[0].status).toBe('FAILED');
    const o2 = await api().post('/api/v1/payments/order').set(auth(m.token)).send({ planId: 'pro', cycle: 'MONTHLY', billing, gateway: 'cashfree' });
    expect(o2.body.gateway).toBe('cashfree');
  });

  it('referral: inviter gets 7 bonus days on the first payment', async () => {
    const inviter = await loginMember();
    const friend = await loginMember(undefined, { referralCode: inviter.user.referralCode });
    const o = await api().post('/api/v1/payments/order').set(auth(friend.token)).send({ planId: 'pro', cycle: 'MONTHLY', billing });
    await api().post('/api/v1/payments/verify').set(auth(friend.token)).send({ paymentId: o.body.paymentId, mock: 'success' });
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, inviter.user.id) });
    expect(u!.bonusDays).toBe(7);
    // Bonus is added when the inviter goes Pro.
    const o2 = await api().post('/api/v1/payments/order').set(auth(inviter.token)).send({ planId: 'pro', cycle: 'MONTHLY', billing });
    await api().post('/api/v1/payments/verify').set(auth(inviter.token)).send({ paymentId: o2.body.paymentId, mock: 'success' });
    const u2 = await db.query.users.findFirst({ where: eq(schema.users.id, inviter.user.id) });
    expect(u2!.bonusDays).toBe(0);
    expect((u2!.planUntil!.getTime() - Date.now()) / 86_400_000).toBeGreaterThan(34);
  });
});

describe('webhooks', () => {
  it('Razorpay payment.captured activates plan; bad signature refused', async () => {
    const m = await loginMember();
    const o = await api().post('/api/v1/payments/order').set(auth(m.token)).send({ planId: 'pro', cycle: 'QUARTERLY', billing });
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_wh_1', order_id: o.body.checkout.orderId, method: 'card' } } } });
    expect((await api().post('/api/v1/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', 'nope').send(body)).status).toBe(400);
    const sig = hmacSha256('whsec_test_123', body);
    expect((await api().post('/api/v1/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', sig).send(body)).status).toBe(200);
    const p = await db.query.payments.findFirst({ where: eq(schema.payments.id, o.body.paymentId) });
    expect(p!.status).toBe('SUCCESS');
    expect(p!.method).toBe('card');
  });

  it('Cashfree PAYMENT_SUCCESS webhook', async () => {
    const m = await loginMember();
    const o = await api().post('/api/v1/payments/order').set(auth(m.token)).send({ planId: 'pro', cycle: 'MONTHLY', billing, gateway: 'cashfree' });
    const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: o.body.checkout.orderId }, payment: { cf_payment_id: 998877, payment_group: 'upi' } } });
    const ts = String(Date.now());
    const sig = hmacSha256('cfsk_test_secret_123456', ts + body, 'base64');
    expect((await api().post('/api/v1/webhooks/cashfree').set('content-type', 'application/json').set('x-webhook-timestamp', ts).set('x-webhook-signature', sig).send(body)).status).toBe(200);
    const p = await db.query.payments.findFirst({ where: eq(schema.payments.id, o.body.paymentId) });
    expect(p!.status).toBe('SUCCESS');
    expect(p!.gatewayPaymentId).toBe('998877');
  });
});

describe('admin payments, plans, coupons, gateway keys', () => {
  it('refund ends the plan; stats and CSV', async () => {
    const m = await loginMember();
    const o = await api().post('/api/v1/payments/order').set(auth(m.token)).send({ planId: 'pro', cycle: 'MONTHLY', billing });
    await api().post('/api/v1/payments/verify').set(auth(m.token)).send({ paymentId: o.body.paymentId, mock: 'success' });
    const part = await api().post(`/api/v1/admin/payments/${o.body.paymentId}/refund`).set(auth(admin.token)).send({ amount: 1000, reason: 'Goodwill' });
    expect(part.body.payment.status).toBe('PARTIAL_REFUND');
    expect((await api().post(`/api/v1/admin/payments/${o.body.paymentId}/refund`).set(auth(admin.token)).send({ amount: 999999, reason: 'Too much' })).status).toBe(400);
    const full = await api().post(`/api/v1/admin/payments/${o.body.paymentId}/refund`).set(auth(admin.token)).send({ reason: 'Asked within 7 days' });
    expect(full.body.payment.status).toBe('REFUNDED');
    expect((await api().get('/api/v1/me').set(auth(m.token))).body.user.plan.isPaid).toBe(false);
    const s = await api().get('/api/v1/admin/payments/stats').set(auth(admin.token));
    expect(s.body.allTime).toBeGreaterThan(0);
    expect(s.body.refunded).toBeGreaterThan(0);
    const csv = await api().get('/api/v1/admin/payments/export.csv').set(auth(admin.token));
    expect(csv.text).toContain('Invoice');
  });

  it('edits plan prices and creates coupons', async () => {
    const p = await api().patch('/api/v1/admin/plans/pro').set(auth(admin.token)).send({ prices: [{ cycle: 'HALFYEARLY', price: 49900, enabled: true }] });
    expect(p.body.items.find((x: { id: string }) => x.id === 'pro').prices.find((x: { cycle: string }) => x.cycle === 'HALFYEARLY').enabled).toBe(true);
    expect((await api().patch('/api/v1/admin/plans/free').set(auth(admin.token)).send({ active: false })).status).toBe(400);
    const c = await api().post('/api/v1/admin/coupons').set(auth(admin.token)).send({ code: 'flat50', amountOff: 5000, maxUses: 1, note: 'Flat ₹50' });
    expect(c.body.item.code).toBe('FLAT50');
    expect((await api().post('/api/v1/admin/coupons').set(auth(admin.token)).send({ code: 'BOTH', percent: 10, amountOff: 100 })).status).toBe(400);
  });

  it('stores gateway secrets encrypted and returns only hints', async () => {
    const r = await api().put('/api/v1/admin/settings/payments').set(auth(admin.token)).send({ razorpay: { test: { keyId: 'rzp_test_abcdefghijk', secret: 'supersecretvalue1234WXYZ' } } });
    expect(r.status).toBe(200);
    const g = await api().get('/api/v1/admin/settings/payments').set(auth(admin.token));
    expect(g.body.razorpay.test.secretHint).toBe('WXYZ');
    expect(JSON.stringify(g.body)).not.toContain('supersecretvalue');
    const row = await db.query.secretSettings.findFirst({ where: eq(schema.secretSettings.key, 'razorpay.test.secret') });
    expect(row!.cipher).not.toContain('supersecret');
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.module, 'settings'));
    expect(JSON.stringify(logs)).not.toContain('supersecret');
    expect((await api().put('/api/v1/admin/settings/payments').set(auth(admin.token)).send({ razorpay: { live: { keyId: 'rzp_test_wrongmode' } } })).status).toBe(400);
    expect((await api().post('/api/v1/admin/settings/payments/razorpay/test').set(auth(admin.token))).body.ok).toBe(true);
  });
});

describe('per-plan features', () => {
  it('a plan without chat or posting castings is refused; turning them back on works', async () => {
    const admin = await loginAdmin();
    const created = await api().post('/api/v1/admin/plans').set(auth(admin.token)).send({
      id: 'basic-test', name: 'Basic test', features: ['Unlimited applications'],
      limits: { applicationsPerMonth: null, chat: false, postCastings: false, videoPosts: false, earlyAccess: true, whoViewed: true, boost: false },
      prices: [{ cycle: 'MONTHLY', price: 4900, enabled: true }],
    });
    expect(created.status).toBe(201);
    const m = await loginMember();
    const other = await loginMember();
    await api().post(`/api/v1/admin/users/${m.user.id}/plan`).set(auth(admin.token)).send({ planId: 'basic-test', days: 30 });
    const chat = await api().post('/api/v1/chat/start').set(auth(m.token)).send({ code: other.user.code });
    expect(chat.status).toBe(402);
    expect(chat.body.error.message).toMatch(/isn’t included/);
    const post = await api().post('/api/v1/my-castings').set(auth(m.token)).send({});
    expect(post.status).toBe(402);
    expect((await api().get('/api/v1/me/views').set(auth(m.token))).body.locked).not.toBe(true);
    await api().patch('/api/v1/admin/plans/basic-test').set(auth(admin.token)).send({ limits: { applicationsPerMonth: null, chat: true, postCastings: true, videoPosts: false, earlyAccess: true, whoViewed: true, boost: false } });
    expect((await api().post('/api/v1/chat/start').set(auth(m.token)).send({ code: other.user.code })).status).not.toBe(402);
  });
});
