import { Router } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { env, isProd } from '../../config/env';
import { optionalMember, requireMember } from '../../middleware/auth';
import { randomCode } from '../../lib/codes';
import { availableGateways, createOrder, fetchStatus, paymentSettings, verifyRazorpaySignature, type GatewayId } from './gateways';
import { CYCLE_MONTHS, markFailed, markPaid, quote, type Cycle } from './service';
import { invoiceHtml } from './invoice';

const { plans, planPrices, payments } = schema;

const cycle = z.enum(['MONTHLY', 'QUARTERLY', 'HALFYEARLY', 'YEARLY']);
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/* ============================ Plans (public) ============================ */
export const plansRouter = Router();

plansRouter.get('/', optionalMember, ah(async (req, res) => {
  const rows = await db.select().from(plans).where(eq(plans.active, true)).orderBy(asc(plans.order));
  const prices = await db.select().from(planPrices).where(eq(planPrices.enabled, true));
  const gateways = await availableGateways();
  const s = await paymentSettings();
  res.json({
    gstRate: 18,
    gateways,
    methods: Object.entries(s[gateways[0] ?? 'razorpay'].methods ?? {}).filter(([, on]) => on).map(([m]) => m),
    current: req.user ? { planId: req.user.planId, cycle: req.user.planCycle, until: req.user.planUntil } : null,
    items: rows.map((p) => ({
      id: p.id, name: p.name, tagline: p.tagline, isFree: p.isFree, popular: p.popular, color: p.color, features: p.features, limits: p.limits,
      prices: prices.filter((x) => x.planId === p.id).map((x) => ({ cycle: x.cycle, months: CYCLE_MONTHS[x.cycle], price: x.price })),
    })),
  });
}));

/* ============================ Payments (member) ============================ */
const router = Router();
router.use(requireMember);

router.post('/quote', ah(async (req, res) => {
  const b = parse(z.object({ planId: z.string(), cycle, coupon: z.string().max(30).optional(), state: z.string().max(60).optional() }), req.body);
  res.json(await quote(b.planId, b.cycle, b.coupon, b.state, req.user?.id));
}));

const orderBody = z.object({
  planId: z.string(), cycle, coupon: z.string().max(30).optional(),
  gateway: z.enum(['razorpay', 'cashfree']).optional(),
  billing: z.object({
    name: z.string().trim().min(2, 'Enter your name').max(80),
    email: z.string().trim().email('Enter a valid email for the invoice').max(120),
    state: z.string().trim().min(2).max(60),
    gstin: z.string().trim().toUpperCase().regex(GSTIN, 'GSTIN should be 15 characters').optional().or(z.literal('')),
  }),
});

/** Creates the order. The app then opens Razorpay Checkout or Cashfree with `checkout`. */
router.post('/order', ah(async (req, res) => {
  const b = parse(orderBody, req.body);
  const q = await quote(b.planId, b.cycle as Cycle, b.coupon, b.billing.state, req.user!.id);
  if (q.couponError) throw badRequest(q.couponError);
  const gws = await availableGateways();
  if (!gws.length) throw badRequest('Payments are not available right now. Please try again later.');
  const gateway: GatewayId = b.gateway && gws.includes(b.gateway) ? b.gateway : gws[0];
  const receipt = `CH${Date.now().toString(36).toUpperCase()}${randomCode(4)}`;
  const order = await createOrder(gateway, {
    receipt, amount: q.amount,
    customer: { id: req.user!.id, name: b.billing.name, phone: req.user!.phone, email: b.billing.email },
    returnUrl: `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/checkout/return`,
    notes: { plan: `${q.plan.name} ${b.cycle}`, member: req.user!.code },
  });
  const [p] = await db.insert(payments).values({
    userId: req.user!.id, planId: q.plan.id, cycle: b.cycle, base: q.base, discount: q.discount, gst: q.gst, amount: q.amount,
    gateway: gateway === 'razorpay' ? 'RAZORPAY' : 'CASHFREE', gatewayOrderId: order.gatewayOrderId, couponCode: q.coupon?.code ?? null,
    billing: { name: b.billing.name, email: b.billing.email, phone: req.user!.phone, state: b.billing.state, gstin: b.billing.gstin || undefined },
  }).returning();
  res.status(201).json({ paymentId: p.id, gateway, amount: q.amount, quote: q, checkout: order.checkout, fallback: gws.find((g) => g !== gateway) ?? null });
}));

const verifyBody = z.object({
  paymentId: z.string(),
  razorpay_order_id: z.string().optional(), razorpay_payment_id: z.string().optional(), razorpay_signature: z.string().optional(),
  method: z.string().max(30).optional(),
  /** Mock mode only (local development): simulate a result. */
  mock: z.enum(['success', 'fail']).optional(),
});

/** Called by the app after checkout closes. Never trust the browser alone: we check the signature / ask the gateway. */
router.post('/verify', ah(async (req, res) => {
  const b = parse(verifyBody, req.body);
  const p = await db.query.payments.findFirst({ where: and(eq(payments.id, b.paymentId), eq(payments.userId, req.user!.id)) });
  if (!p) throw notFound('Payment');
  if (p.status === 'SUCCESS') return res.json({ status: 'SUCCESS', payment: p });

  if (env.PAYMENTS_MOCK && b.mock && !isProd) {
    if (b.mock === 'fail') { await markFailed(p.id, 'Payment declined (test)'); return res.json({ status: 'FAILED', reason: 'Payment declined (test)' }); }
    const r = await markPaid(p.id, { gatewayPaymentId: `pay_mock_${randomCode(10)}`, method: b.method ?? 'UPI' });
    return res.json({ status: 'SUCCESS', payment: r.payment });
  }

  if (p.gateway === 'RAZORPAY' && b.razorpay_payment_id && b.razorpay_signature) {
    if (b.razorpay_order_id && b.razorpay_order_id !== p.gatewayOrderId) throw badRequest('Order does not match');
    const ok = await verifyRazorpaySignature(p.gatewayOrderId, b.razorpay_payment_id, b.razorpay_signature);
    if (!ok) throw badRequest('We could not confirm this payment. If money was taken, it will be refunded automatically.');
    const r = await markPaid(p.id, { gatewayPaymentId: b.razorpay_payment_id, method: b.method });
    return res.json({ status: 'SUCCESS', payment: r.payment });
  }

  const s = await fetchStatus(p.gateway === 'RAZORPAY' ? 'razorpay' : 'cashfree', p.gatewayOrderId);
  if (s.status === 'SUCCESS') {
    const r = await markPaid(p.id, { gatewayPaymentId: s.gatewayPaymentId, method: s.method });
    return res.json({ status: 'SUCCESS', payment: r.payment });
  }
  if (s.status === 'FAILED') await markFailed(p.id, s.reason ?? 'Payment failed');
  res.json({ status: s.status, reason: s.reason });
}));

/** Checkout was closed or the payment failed in the app. */
router.post('/:id/failed', ah(async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().max(300).default('Payment cancelled') }), req.body ?? {});
  const p = await db.query.payments.findFirst({ where: and(eq(payments.id, req.params.id), eq(payments.userId, req.user!.id)) });
  if (!p) throw notFound('Payment');
  await markFailed(p.id, reason);
  const gws = await availableGateways();
  const used = p.gateway === 'RAZORPAY' ? 'razorpay' : 'cashfree';
  res.json({ ok: true, tryInstead: gws.find((g) => g !== used) ?? null });
}));

router.get('/', ah(async (req, res) => {
  const rows = await db.select().from(payments).where(eq(payments.userId, req.user!.id)).orderBy(desc(payments.createdAt)).limit(100);
  res.json({ items: rows.filter((p) => p.status !== 'CREATED').map((p) => ({ id: p.id, planId: p.planId, cycle: p.cycle, base: p.base, discount: p.discount, gst: p.gst, amount: p.amount, status: p.status, method: p.method, gateway: p.gateway, invoiceNo: p.invoiceNo, couponCode: p.couponCode, refundAmount: p.refundAmount, createdAt: p.createdAt, paidAt: p.paidAt, failureReason: p.failureReason })) });
}));

/** Printable GST invoice (HTML — "Save as PDF" from the browser). */
router.get('/:id/invoice', ah(async (req, res) => {
  const p = await db.query.payments.findFirst({ where: and(eq(payments.id, req.params.id), eq(payments.userId, req.user!.id)) });
  if (!p || !p.invoiceNo) throw notFound('Invoice');
  res.type('html').send(await invoiceHtml(p));
}));

/** Turn auto-renew on/off. Pro stays on until the paid period ends. */
router.post('/auto-renew', ah(async (req, res) => {
  const { on } = parse(z.object({ on: z.boolean() }), req.body);
  await db.update(schema.users).set({ autoRenew: on }).where(eq(schema.users.id, req.user!.id));
  res.json({ autoRenew: on, planUntil: req.user!.planUntil });
}));

export default router;
