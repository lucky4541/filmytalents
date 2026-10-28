import { Router } from 'express';
import { and, asc, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { notify } from '../../lib/notify';
import { secretHints, setSecret, setSetting } from '../../lib/settings';
import { maskPhone, randomCode } from '../../lib/codes';
import { clearPlanCache, requireAdmin, requirePerm } from '../../middleware/auth';
import { env } from '../../config/env';
import { fetchStatus, paymentSettings, refund, secretKey, testConnection, type GatewayId, type Mode } from './gateways';
import { markPaid, rupees } from './service';
import { invoiceHtml } from './invoice';

const { payments, users, plans, planPrices, coupons } = schema;
const cycle = z.enum(['MONTHLY', 'QUARTERLY', 'HALFYEARLY', 'YEARLY']);

/* ============================ Payments ============================ */
export const adminPayments = Router();
adminPayments.use(requireAdmin, requirePerm('payments'));

const listQuery = z.object({
  status: z.enum(['CREATED', 'SUCCESS', 'FAILED', 'REFUNDED', 'PARTIAL_REFUND']).optional(),
  gateway: z.enum(['RAZORPAY', 'CASHFREE']).optional(),
  planId: z.string().optional(), q: z.string().trim().max(80).optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(),
});

function where(f: z.infer<typeof listQuery>) {
  const w: SQL[] = [];
  if (f.status) w.push(eq(payments.status, f.status));
  if (f.gateway) w.push(eq(payments.gateway, f.gateway));
  if (f.planId) w.push(eq(payments.planId, f.planId));
  if (f.from) w.push(gte(payments.createdAt, f.from));
  if (f.to) w.push(lte(payments.createdAt, f.to));
  if (f.q) w.push(or(ilike(payments.invoiceNo, `%${f.q}%`), ilike(payments.gatewayOrderId, `%${f.q}%`), ilike(payments.gatewayPaymentId, `%${f.q}%`), ilike(users.name, `%${f.q}%`), ilike(users.code, `%${f.q}%`))!);
  return w.length ? and(...w) : undefined;
}

const view = (p: typeof payments.$inferSelect, u: typeof users.$inferSelect | null) => ({ ...p, member: u ? { id: u.id, code: u.code, name: u.name, phoneMasked: maskPhone(u.phone) } : null });

adminPayments.get('/', ah(async (req, res) => {
  const f = parse(listQuery, req.query);
  const { page, limit, skip } = paging(req.query, 200);
  const w = where(f);
  const [{ n }] = await db.select({ n: count() }).from(payments).leftJoin(users, eq(users.id, payments.userId)).where(w);
  const rows = await db.select({ p: payments, u: users }).from(payments).leftJoin(users, eq(users.id, payments.userId)).where(w).orderBy(desc(payments.createdAt)).limit(limit).offset(skip);
  res.json(pageResult(rows.map((r) => view(r.p, r.u)), n, page, limit));
}));

/** Money tiles for the dashboard (paise). "Net" = collected − refunded. */
adminPayments.get('/stats', ah(async (_req, res) => {
  const ok = sql`${payments.status} IN ('SUCCESS','REFUNDED','PARTIAL_REFUND')`;
  const [r] = await db.select({
    today: sql<number>`coalesce(sum(${payments.amount}) FILTER (WHERE ${ok} AND ${payments.paidAt} >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'), 0)`.mapWith(Number),
    month: sql<number>`coalesce(sum(${payments.amount}) FILTER (WHERE ${ok} AND ${payments.paidAt} >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'), 0)`.mapWith(Number),
    allTime: sql<number>`coalesce(sum(${payments.amount}) FILTER (WHERE ${ok}), 0)`.mapWith(Number),
    refunded: sql<number>`coalesce(sum(${payments.refundAmount}), 0)`.mapWith(Number),
    gstMonth: sql<number>`coalesce(sum(${payments.gst}) FILTER (WHERE ${ok} AND ${payments.paidAt} >= date_trunc('month', now())), 0)`.mapWith(Number),
    success: sql<number>`count(*) FILTER (WHERE ${ok})`.mapWith(Number),
    failed: sql<number>`count(*) FILTER (WHERE ${payments.status} = 'FAILED')`.mapWith(Number),
    razorpay: sql<number>`coalesce(sum(${payments.amount}) FILTER (WHERE ${ok} AND ${payments.gateway} = 'RAZORPAY'), 0)`.mapWith(Number),
    cashfree: sql<number>`coalesce(sum(${payments.amount}) FILTER (WHERE ${ok} AND ${payments.gateway} = 'CASHFREE'), 0)`.mapWith(Number),
  }).from(payments);
  const [members] = await db.select({ paid: sql<number>`count(*) FILTER (WHERE ${users.planId} <> 'free' AND (${users.planUntil} IS NULL OR ${users.planUntil} > now()))`.mapWith(Number) }).from(users);
  const byDay = await db.execute(sql`SELECT to_char(date_trunc('day', paid_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day, sum(amount)::int AS amount, count(*)::int AS n
    FROM payments WHERE status IN ('SUCCESS','REFUNDED','PARTIAL_REFUND') AND paid_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`);
  res.json({ ...r, net: r.allTime - r.refunded, successRate: r.success + r.failed ? Math.round((r.success / (r.success + r.failed)) * 100) : null, paidMembers: members.paid, last30Days: byDay.rows });
}));

adminPayments.get('/export.csv', ah(async (req, res) => {
  const f = parse(listQuery, req.query);
  const rows = await db.select({ p: payments, u: users }).from(payments).leftJoin(users, eq(users.id, payments.userId)).where(where(f)).orderBy(asc(payments.createdAt)).limit(50_000);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Date', 'Invoice', 'Member', 'Name', 'Plan', 'Cycle', 'Base ₹', 'Discount ₹', 'GST ₹', 'Total ₹', 'Refunded ₹', 'Status', 'Gateway', 'Method', 'Coupon', 'Billing state', 'GSTIN', 'Gateway order', 'Gateway payment'];
  const r2 = (p: number) => (p / 100).toFixed(2);
  const lines = rows.map(({ p, u }) => [(p.paidAt ?? p.createdAt).toISOString().slice(0, 10), p.invoiceNo, u?.code, p.billing.name ?? u?.name, p.planId, p.cycle, r2(p.base), r2(p.discount), r2(p.gst), r2(p.amount), r2(p.refundAmount), p.status, p.gateway, p.method, p.couponCode, p.billing.state, p.billing.gstin, p.gatewayOrderId, p.gatewayPaymentId].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
  res.send('﻿' + [head.map(esc).join(','), ...lines].join('\n'));
}));

async function load(id: string) {
  const p = await db.query.payments.findFirst({ where: eq(payments.id, id) });
  if (!p) throw notFound('Payment');
  return p;
}

adminPayments.get('/:id', ah(async (req, res) => {
  const p = await load(req.params.id);
  const u = await db.query.users.findFirst({ where: eq(users.id, p.userId) });
  res.json({ payment: view(p, u ?? null) });
}));

adminPayments.get('/:id/invoice', ah(async (req, res) => {
  const p = await load(req.params.id);
  if (!p.invoiceNo) throw notFound('Invoice');
  res.type('html').send(await invoiceHtml(p));
}));

/** Asks the gateway for the latest status (fixes payments stuck at "created" if a webhook was missed). */
adminPayments.post('/:id/sync', ah(async (req, res) => {
  const p = await load(req.params.id);
  if (p.status !== 'CREATED' && p.status !== 'FAILED') return res.json({ payment: p, changed: false });
  const s = await fetchStatus(p.gateway === 'RAZORPAY' ? 'razorpay' : 'cashfree', p.gatewayOrderId);
  if (s.status === 'SUCCESS') {
    const r = await markPaid(p.id, { gatewayPaymentId: s.gatewayPaymentId, method: s.method });
    await audit(req, 'payments', 'Synced payment → success', p.gatewayOrderId);
    return res.json({ payment: r.payment, changed: true });
  }
  res.json({ payment: p, changed: false, gatewayStatus: s.status });
}));

/** Full or partial refund. Full refunds end the plan unless keepPlan is true. */
adminPayments.post('/:id/refund', ah(async (req, res) => {
  const p = await load(req.params.id);
  const b = parse(z.object({ amount: z.coerce.number().int().positive().optional(), reason: z.string().trim().min(3, 'Add a reason').max(300), keepPlan: z.boolean().default(false) }), req.body);
  if (!['SUCCESS', 'PARTIAL_REFUND'].includes(p.status)) throw badRequest('Only successful payments can be refunded');
  const left = p.amount - p.refundAmount;
  const amount = b.amount ?? left;
  if (amount > left) throw badRequest(`You can refund up to ${rupees(left)}`);
  const r = await refund(p.gateway === 'RAZORPAY' ? 'razorpay' : 'cashfree', { gatewayOrderId: p.gatewayOrderId, gatewayPaymentId: p.gatewayPaymentId, amount, refundId: `rf_${randomCode(10)}` });
  const total = p.refundAmount + amount;
  const full = total >= p.amount;
  const [row] = await db.update(payments).set({ refundAmount: total, refundReason: b.reason, refundId: r.refundId, status: full ? 'REFUNDED' : 'PARTIAL_REFUND', refundedAt: env.PAYMENTS_MOCK ? new Date() : null }).where(eq(payments.id, p.id)).returning();
  if (full && !b.keepPlan) {
    const later = await db.query.payments.findFirst({ where: and(eq(payments.userId, p.userId), eq(payments.status, 'SUCCESS'), gte(payments.paidAt, p.paidAt ?? p.createdAt)) });
    if (!later || later.id === p.id) await db.update(users).set({ planId: 'free', planCycle: null, planUntil: null }).where(eq(users.id, p.userId));
  }
  await notify(p.userId, 'payment', 'Refund started', `${rupees(amount)} is on its way to your original payment method (5–7 working days).`, '/my-plan');
  await audit(req, 'payments', `Refunded ${rupees(amount)}${full ? ' (full)' : ''}: ${b.reason}`, p.invoiceNo ?? p.gatewayOrderId);
  res.json({ payment: row });
}));

/* ============================ Plans ============================ */
export const adminPlans = Router();
adminPlans.use(requireAdmin, requirePerm('plans'));

const limits = z.object({ applicationsPerMonth: z.number().int().min(0).nullable(), chat: z.boolean(), postCastings: z.boolean(), videoPosts: z.boolean(), earlyAccess: z.boolean(), whoViewed: z.boolean(), boost: z.boolean() });
const planInput = z.object({
  name: z.string().trim().min(2).max(40), tagline: z.string().max(120).default(''), active: z.boolean().default(true), popular: z.boolean().default(false),
  color: z.string().max(20).default('gold'), order: z.number().int().default(1), trialDays: z.number().int().min(0).max(90).default(0),
  features: z.array(z.string().trim().min(1).max(100)).max(20).default([]), limits,
  prices: z.array(z.object({ cycle, price: z.number().int().min(100, 'Minimum ₹1 (100 paise)').max(10_000_000), enabled: z.boolean().default(true) })).max(4).default([]),
});

async function planView() {
  const rows = await db.select().from(plans).orderBy(asc(plans.order));
  const prices = await db.select().from(planPrices);
  const members = await db.select({ planId: users.planId, n: count() }).from(users).where(sql`${users.status} <> 'DELETED'`).groupBy(users.planId);
  return rows.map((p) => ({ ...p, prices: prices.filter((x) => x.planId === p.id), members: members.find((m) => m.planId === p.id)?.n ?? 0 }));
}

adminPlans.get('/', ah(async (_req, res) => { res.json({ items: await planView() }); }));

adminPlans.post('/', ah(async (req, res) => {
  const b = parse(planInput.extend({ id: z.string().regex(/^[a-z0-9-]{2,30}$/, 'Plan id: lowercase letters, numbers and dashes') }), req.body);
  const { prices, ...plan } = b;
  await db.insert(plans).values({ ...plan, isFree: false });
  if (prices.length) await db.insert(planPrices).values(prices.map((p) => ({ ...p, planId: b.id })));
  clearPlanCache();
  await audit(req, 'plans', 'Created plan', b.name);
  res.status(201).json({ items: await planView() });
}));

adminPlans.patch('/:id', ah(async (req, res) => {
  const existing = await db.query.plans.findFirst({ where: eq(plans.id, req.params.id) });
  if (!existing) throw notFound('Plan');
  const b = parse(planInput.partial(), req.body);
  const { prices, ...plan } = b;
  if (existing.isFree && prices?.length) throw badRequest('The Free plan has no prices');
  if (existing.isFree && plan.active === false) throw badRequest('The Free plan can’t be turned off');
  if (Object.keys(plan).length) await db.update(plans).set(plan).where(eq(plans.id, existing.id));
  for (const p of prices ?? []) {
    await db.insert(planPrices).values({ ...p, planId: existing.id }).onConflictDoUpdate({ target: [planPrices.planId, planPrices.cycle], set: { price: p.price, enabled: p.enabled } });
  }
  clearPlanCache();
  await audit(req, 'plans', `Edited plan (${Object.keys(b).join(', ')})${prices ? `: ${prices.map((p) => `${p.cycle.toLowerCase()} ${rupees(p.price)}${p.enabled ? '' : ' off'}`).join(', ')}` : ''}`, existing.name);
  res.json({ items: await planView() });
}));

/* ============================ Coupons ============================ */
export const adminCoupons = Router();
adminCoupons.use(requireAdmin, requirePerm('plans'));

const couponInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/, 'Code: 3–20 letters/numbers'),
  percent: z.number().int().min(1).max(100).nullable().optional(),
  amountOff: z.number().int().min(100).nullable().optional(),
  planIds: z.array(z.string()).default([]), cycles: z.array(cycle).default([]),
  maxUses: z.number().int().min(1).nullable().optional(),
  validFrom: z.coerce.date().nullable().optional(), validTo: z.coerce.date().nullable().optional(),
  active: z.boolean().default(true), note: z.string().max(200).default(''),
}).refine((c) => !!c.percent !== !!c.amountOff, 'Set either a % discount or a fixed amount off');

adminCoupons.get('/', ah(async (_req, res) => {
  const rows = await db.select().from(coupons).orderBy(desc(coupons.createdAt));
  const revenue = await db.select({ code: payments.couponCode, n: count(), discount: sql<number>`sum(${payments.discount})`.mapWith(Number) }).from(payments).where(eq(payments.status, 'SUCCESS')).groupBy(payments.couponCode);
  res.json({ items: rows.map((c) => ({ ...c, discountGiven: revenue.find((r) => r.code === c.code)?.discount ?? 0 })) });
}));

adminCoupons.post('/', ah(async (req, res) => {
  const b = parse(couponInput, req.body);
  const [item] = await db.insert(coupons).values({ ...b, percent: b.percent ?? null, amountOff: b.amountOff ?? null }).returning();
  await audit(req, 'plans', 'Created coupon', b.code);
  res.status(201).json({ item });
}));

adminCoupons.patch('/:id', ah(async (req, res) => {
  const b = parse(z.object({ active: z.boolean(), maxUses: z.number().int().min(1).nullable(), validTo: z.coerce.date().nullable(), note: z.string().max(200), planIds: z.array(z.string()), cycles: z.array(cycle) }).partial(), req.body);
  const [item] = await db.update(coupons).set(b).where(eq(coupons.id, req.params.id)).returning();
  if (!item) throw notFound('Coupon');
  await audit(req, 'plans', `Edited coupon (${Object.keys(b).join(', ')})`, item.code);
  res.json({ item });
}));

adminCoupons.delete('/:id', ah(async (req, res) => {
  const [item] = await db.delete(coupons).where(eq(coupons.id, req.params.id)).returning();
  if (!item) throw notFound('Coupon');
  await audit(req, 'plans', 'Deleted coupon', item.code);
  res.json({ ok: true });
}));

/* ============================ Gateway settings ============================ */
export const adminGateways = Router();
adminGateways.use(requireAdmin, requirePerm('settings'));

/** Current payment settings. Secrets are never returned — only their last 4 characters. */
adminGateways.get('/', ah(async (_req, res) => {
  const s = await paymentSettings();
  const hints = await secretHints();
  const h = (g: GatewayId, m: Mode) => ({ secretHint: hints[secretKey(g, m, 'secret')] ?? null, webhookHint: hints[secretKey(g, m, 'webhookSecret')] ?? null });
  res.json({
    ...s, mock: env.PAYMENTS_MOCK,
    razorpay: { ...s.razorpay, test: { ...s.razorpay.test, ...h('razorpay', 'test') }, live: { ...s.razorpay.live, ...h('razorpay', 'live') } },
    cashfree: { ...s.cashfree, test: { ...s.cashfree.test, ...h('cashfree', 'test') }, live: { ...s.cashfree.live, ...h('cashfree', 'live') } },
    webhooks: { razorpay: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/webhooks/razorpay`, cashfree: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/webhooks/cashfree` },
  });
}));

const modeCreds = z.object({ keyId: z.string().trim().max(100).optional(), secret: z.string().trim().min(8).max(200).optional(), webhookSecret: z.string().trim().min(6).max(200).optional() });
const gwInput = z.object({ enabled: z.boolean().optional(), mode: z.enum(['test', 'live']).optional(), methods: z.record(z.boolean()).optional(), test: modeCreds.optional(), live: modeCreds.optional() });

adminGateways.put('/', ah(async (req, res) => {
  const b = parse(z.object({
    primary: z.enum(['razorpay', 'cashfree']).optional(), fallback: z.boolean().optional(),
    razorpay: gwInput.optional(), cashfree: gwInput.optional(),
    business: z.object({ legalName: z.string().max(120), gstin: z.string().toUpperCase().regex(/^$|^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'GSTIN should be 15 characters'), invoicePrefix: z.string().max(20), address: z.string().max(300), sac: z.string().max(10), state: z.string().max(60) }).partial().optional(),
  }), req.body);
  const s = await paymentSettings();
  const changed: string[] = [];
  for (const g of ['razorpay', 'cashfree'] as const) {
    const gi = b[g];
    if (!gi) continue;
    for (const m of ['test', 'live'] as const) {
      const c = gi[m];
      if (!c) continue;
      if (c.keyId !== undefined) {
        if (g === 'razorpay' && c.keyId && !c.keyId.startsWith(m === 'test' ? 'rzp_test_' : 'rzp_live_')) throw badRequest(`Razorpay ${m} keys start with ${m === 'test' ? 'rzp_test_' : 'rzp_live_'}`);
        s[g][m] = { ...(s[g][m] ?? {}), keyId: c.keyId, verifiedAt: null };
        changed.push(`${g} ${m} key id`);
      }
      if (c.secret) { await setSecret(secretKey(g, m, 'secret'), c.secret, req.admin!.name); s[g][m] = { ...(s[g][m] ?? {}), verifiedAt: null }; changed.push(`${g} ${m} secret`); }
      if (c.webhookSecret) { await setSecret(secretKey(g, m, 'webhookSecret'), c.webhookSecret, req.admin!.name); changed.push(`${g} ${m} webhook secret`); }
    }
    if (gi.enabled !== undefined) { s[g].enabled = gi.enabled; changed.push(`${g} ${gi.enabled ? 'on' : 'off'}`); }
    if (gi.mode) { s[g].mode = gi.mode; changed.push(`${g} mode ${gi.mode}`); }
    if (gi.methods) s[g].methods = { ...(s[g].methods ?? {}), ...gi.methods };
  }
  if (b.primary) { s.primary = b.primary; changed.push(`primary ${b.primary}`); }
  if (b.fallback !== undefined) s.fallback = b.fallback;
  if (b.business) s.business = { ...s.business, ...b.business };
  if (!s.razorpay.enabled && !s.cashfree.enabled) throw badRequest('Keep at least one payment gateway on');
  await setSetting('payments', s, req.admin!.name);
  // Never write secret values to the audit log — only what changed.
  await audit(req, 'settings', `Payment settings: ${changed.join(', ') || 'updated'}`, 'payments');
  res.json({ ok: true });
}));

adminGateways.post('/:gateway/test', ah(async (req, res) => {
  const g = parse(z.enum(['razorpay', 'cashfree']), req.params.gateway);
  const r = await testConnection(g);
  if (r.ok) {
    const s = await paymentSettings();
    s[g][s[g].mode] = { ...(s[g][s[g].mode] ?? {}), verifiedAt: new Date().toISOString() };
    await setSetting('payments', s, req.admin!.name);
  }
  await audit(req, 'settings', `Tested ${g} connection: ${r.ok ? 'ok' : 'failed'}`, 'payments');
  res.json(r);
}));
