import { env } from '../../config/env';
import { getSecret, getSetting } from '../../lib/settings';
import { hmacSha256, safeEqual } from '../../lib/crypto';
import { HttpError, badRequest } from '../../lib/errors';
import { logger } from '../../lib/logger';

/**
 * Razorpay + Cashfree. Keys come from Admin → Settings → Payments (secrets are stored encrypted)
 * and fall back to the .env values. PAYMENTS_MOCK=true fakes both gateways for local development.
 */
export type GatewayId = 'razorpay' | 'cashfree';
export type Mode = 'test' | 'live';

export interface GatewaySettings {
  enabled: boolean;
  mode: Mode;
  test?: { keyId?: string; verifiedAt?: string | null };
  live?: { keyId?: string; verifiedAt?: string | null };
  methods?: Record<string, boolean>;
}
export interface PaymentSettings {
  primary: GatewayId;
  fallback: boolean;
  razorpay: GatewaySettings;
  cashfree: GatewaySettings;
  business: { legalName: string; gstin: string; invoicePrefix: string; address: string; sac: string; state?: string };
}

export const secretKey = (g: GatewayId, mode: Mode, kind: 'secret' | 'webhookSecret') => `${g}.${mode}.${kind}`;

export async function paymentSettings(): Promise<PaymentSettings> {
  const s = await getSetting<Partial<PaymentSettings>>('payments', {});
  return {
    primary: s.primary ?? 'razorpay',
    fallback: s.fallback ?? true,
    razorpay: { enabled: true, mode: 'test', ...(s.razorpay ?? {}) },
    cashfree: { enabled: false, mode: env.CASHFREE_ENV === 'production' ? 'live' : 'test', ...(s.cashfree ?? {}) },
    business: { legalName: 'FilmyTalents', gstin: '', invoicePrefix: 'CH-INV-', address: '', sac: '998439', state: 'Telangana', ...(s.business ?? {}) },
  };
}

export interface Creds { gateway: GatewayId; mode: Mode; keyId: string; secret: string; webhookSecret: string }

export async function credsFor(g: GatewayId): Promise<Creds> {
  const s = await paymentSettings();
  const mode = s[g].mode ?? 'test';
  const keyId = s[g][mode]?.keyId || (g === 'razorpay' ? env.RAZORPAY_KEY_ID : env.CASHFREE_APP_ID);
  const secret = (await getSecret(secretKey(g, mode, 'secret'))) || (g === 'razorpay' ? env.RAZORPAY_KEY_SECRET : env.CASHFREE_SECRET_KEY);
  const webhookSecret = (await getSecret(secretKey(g, mode, 'webhookSecret'))) || (g === 'razorpay' ? env.RAZORPAY_WEBHOOK_SECRET : secret);
  return { gateway: g, mode, keyId, secret, webhookSecret };
}

/** Which gateways can take a payment right now (primary first). */
export async function availableGateways(): Promise<GatewayId[]> {
  const s = await paymentSettings();
  const order: GatewayId[] = s.primary === 'cashfree' ? ['cashfree', 'razorpay'] : ['razorpay', 'cashfree'];
  const out: GatewayId[] = [];
  for (const g of order) {
    if (!s[g].enabled) continue;
    if (env.PAYMENTS_MOCK) { out.push(g); continue; }
    const c = await credsFor(g);
    if (c.keyId && c.secret) out.push(g);
  }
  return s.fallback ? out : out.slice(0, 1);
}

const fetchJson = async (url: string, init: RequestInit) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    logger.warn({ url, status: res.status, body }, 'gateway error');
    const msg = (body.error as { description?: string })?.description ?? (body.message as string) ?? `Gateway error ${res.status}`;
    throw new HttpError(502, `Payment gateway: ${msg}`, 'GATEWAY_ERROR');
  }
  return body;
};

/* ============================ Razorpay ============================ */
const rzpAuth = (c: Creds) => `Basic ${Buffer.from(`${c.keyId}:${c.secret}`).toString('base64')}`;

/* ============================ Cashfree ============================ */
const cfBase = (c: Creds) => (c.mode === 'live' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg');
const cfHeaders = (c: Creds) => ({ 'x-client-id': c.keyId, 'x-client-secret': c.secret, 'x-api-version': '2023-08-01', 'content-type': 'application/json' });

export interface OrderInput { receipt: string; amount: number /* paise */; customer: { id: string; name: string; phone: string; email?: string }; returnUrl: string; notes?: Record<string, string> }
export interface OrderResult { gatewayOrderId: string; checkout: Record<string, unknown> }

export async function createOrder(g: GatewayId, o: OrderInput): Promise<OrderResult> {
  if (env.PAYMENTS_MOCK) {
    const id = `${g === 'razorpay' ? 'order' : 'cf'}_mock_${o.receipt}`;
    return { gatewayOrderId: id, checkout: { mock: true, gateway: g, orderId: id, amount: o.amount, currency: 'INR' } };
  }
  const c = await credsFor(g);
  if (!c.keyId || !c.secret) throw badRequest(`${g === 'razorpay' ? 'Razorpay' : 'Cashfree'} keys are not set up yet`);
  if (g === 'razorpay') {
    const r = await fetchJson('https://api.razorpay.com/v1/orders', {
      method: 'POST', headers: { authorization: rzpAuth(c), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: o.amount, currency: 'INR', receipt: o.receipt, notes: o.notes ?? {} }),
    });
    return { gatewayOrderId: String(r.id), checkout: { gateway: 'razorpay', keyId: c.keyId, orderId: r.id, amount: o.amount, currency: 'INR', prefill: { name: o.customer.name, email: o.customer.email, contact: o.customer.phone } } };
  }
  const r = await fetchJson(`${cfBase(c)}/orders`, {
    method: 'POST', headers: cfHeaders(c),
    body: JSON.stringify({
      order_id: o.receipt, order_amount: o.amount / 100, order_currency: 'INR',
      customer_details: { customer_id: o.customer.id, customer_name: o.customer.name, customer_phone: o.customer.phone.replace(/^\+91/, ''), customer_email: o.customer.email || undefined },
      order_meta: { return_url: `${o.returnUrl}${o.returnUrl.includes('?') ? '&' : '?'}order_id={order_id}` },
      order_note: o.notes?.plan ?? '',
    }),
  });
  return { gatewayOrderId: String(r.order_id), checkout: { gateway: 'cashfree', mode: c.mode === 'live' ? 'production' : 'sandbox', paymentSessionId: r.payment_session_id, orderId: r.order_id, amount: o.amount } };
}

export interface PaymentCheck { status: 'SUCCESS' | 'FAILED' | 'PENDING'; gatewayPaymentId?: string; method?: string; reason?: string }

/** Razorpay Checkout returns these three values; the signature proves the payment is real. */
export async function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string) {
  if (env.PAYMENTS_MOCK) return signature === 'mock_ok';
  const c = await credsFor('razorpay');
  return safeEqual(hmacSha256(c.secret, `${orderId}|${paymentId}`), signature);
}

/** Asks the gateway for the real status (used after Cashfree redirect, and by "Sync" in admin). */
export async function fetchStatus(g: GatewayId, gatewayOrderId: string): Promise<PaymentCheck> {
  if (env.PAYMENTS_MOCK) return { status: 'PENDING' };
  const c = await credsFor(g);
  if (g === 'razorpay') {
    const r = await fetchJson(`https://api.razorpay.com/v1/orders/${gatewayOrderId}/payments`, { headers: { authorization: rzpAuth(c) } });
    const items = (r.items as { id: string; status: string; method: string; error_description?: string }[]) ?? [];
    const ok = items.find((p) => p.status === 'captured');
    if (ok) return { status: 'SUCCESS', gatewayPaymentId: ok.id, method: ok.method };
    if (items.length && items.every((p) => p.status === 'failed')) return { status: 'FAILED', reason: items[0].error_description };
    return { status: 'PENDING' };
  }
  const o = await fetchJson(`${cfBase(c)}/orders/${gatewayOrderId}`, { headers: cfHeaders(c) });
  if (o.order_status === 'PAID') {
    const pays = (await fetchJson(`${cfBase(c)}/orders/${gatewayOrderId}/payments`, { headers: cfHeaders(c) })) as unknown as { cf_payment_id: number; payment_status: string; payment_group: string }[];
    const ok = Array.isArray(pays) ? pays.find((p) => p.payment_status === 'SUCCESS') : undefined;
    return { status: 'SUCCESS', gatewayPaymentId: ok ? String(ok.cf_payment_id) : undefined, method: ok?.payment_group };
  }
  if (o.order_status === 'EXPIRED' || o.order_status === 'TERMINATED') return { status: 'FAILED', reason: `Order ${String(o.order_status).toLowerCase()}` };
  return { status: 'PENDING' };
}

export async function refund(g: GatewayId, p: { gatewayOrderId: string; gatewayPaymentId: string | null; amount: number; refundId: string }) {
  if (env.PAYMENTS_MOCK) return { refundId: `rfnd_mock_${p.refundId}` };
  const c = await credsFor(g);
  if (g === 'razorpay') {
    if (!p.gatewayPaymentId) throw badRequest('This payment has no Razorpay payment id');
    const r = await fetchJson(`https://api.razorpay.com/v1/payments/${p.gatewayPaymentId}/refund`, { method: 'POST', headers: { authorization: rzpAuth(c), 'content-type': 'application/json' }, body: JSON.stringify({ amount: p.amount, notes: { refund: p.refundId } }) });
    return { refundId: String(r.id) };
  }
  const r = await fetchJson(`${cfBase(c)}/orders/${p.gatewayOrderId}/refunds`, { method: 'POST', headers: cfHeaders(c), body: JSON.stringify({ refund_amount: p.amount / 100, refund_id: p.refundId }) });
  return { refundId: String(r.cf_refund_id ?? r.refund_id) };
}

/** Checks the keys work by making a harmless API call. Used by "Test connection" in admin. */
export async function testConnection(g: GatewayId): Promise<{ ok: boolean; message: string }> {
  if (env.PAYMENTS_MOCK) return { ok: true, message: 'Mock mode: no real call made (PAYMENTS_MOCK=true)' };
  const c = await credsFor(g);
  if (!c.keyId || !c.secret) return { ok: false, message: 'Add the key and secret first' };
  try {
    if (g === 'razorpay') await fetchJson('https://api.razorpay.com/v1/orders?count=1', { headers: { authorization: rzpAuth(c) } });
    else {
      const res = await fetch(`${cfBase(c)}/orders/ch_connection_test`, { headers: cfHeaders(c), signal: AbortSignal.timeout(15_000) });
      if (res.status === 401 || res.status === 403) return { ok: false, message: 'Cashfree rejected these keys' };
    }
    return { ok: true, message: `Connected to ${g === 'razorpay' ? 'Razorpay' : 'Cashfree'} (${c.mode})` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/* ============================ Webhooks ============================ */

export async function verifyRazorpayWebhook(raw: Buffer, signature: string | undefined) {
  if (!signature) return false;
  const c = await credsFor('razorpay');
  if (!c.webhookSecret) return false;
  return safeEqual(hmacSha256(c.webhookSecret, raw.toString('utf8')), signature);
}

export async function verifyCashfreeWebhook(raw: Buffer, signature: string | undefined, timestamp: string | undefined) {
  if (!signature || !timestamp) return false;
  const c = await credsFor('cashfree');
  if (!c.secret) return false;
  return safeEqual(hmacSha256(c.webhookSecret || c.secret, timestamp + raw.toString('utf8'), 'base64'), signature);
}
