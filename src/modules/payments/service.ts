import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db, schema } from '../../db';
import type { User } from '../../db/schema';
import { badRequest, notFound } from '../../lib/errors';
import { notify, notifyRule } from '../../lib/notify';
import { logger } from '../../lib/logger';
import { paymentSettings } from './gateways';

const { plans, planPrices, coupons, payments, users } = schema;

export type Cycle = 'MONTHLY' | 'QUARTERLY' | 'HALFYEARLY' | 'YEARLY';
export const CYCLE_MONTHS: Record<Cycle, number> = { MONTHLY: 1, QUARTERLY: 3, HALFYEARLY: 6, YEARLY: 12 };
export const GST_RATE = 18;
export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Checks a coupon for this plan + cycle. Returns the coupon or a friendly error. */
export async function checkCoupon(code: string, planId: string, cycle: Cycle, userId?: string) {
  const c = await db.query.coupons.findFirst({ where: eq(coupons.code, code.trim().toUpperCase()) });
  const now = new Date();
  if (!c || !c.active) return { error: 'This code isn’t valid' };
  if (c.validFrom && c.validFrom > now) return { error: 'This code isn’t active yet' };
  if (c.validTo && c.validTo < now) return { error: 'This code has expired' };
  if (c.maxUses !== null && c.used >= c.maxUses) return { error: 'This code has been fully used' };
  if (c.planIds.length && !c.planIds.includes(planId)) return { error: 'This code doesn’t work on this plan' };
  if (c.cycles.length && !c.cycles.includes(cycle)) return { error: `Works only on ${c.cycles.map((x) => x.toLowerCase()).join(' / ')} billing` };
  // Each member can use a code once.
  if (userId) {
    const used = await db.query.payments.findFirst({ where: and(eq(payments.userId, userId), eq(payments.couponCode, c.code), inArray(payments.status, ['SUCCESS', 'PARTIAL_REFUND'])), columns: { id: true } });
    if (used) return { error: 'You’ve already used this code' };
  }
  return { coupon: c };
}

/**
 * Price in paise. GST is 18% on (price − discount):
 * same state as the business → CGST 9% + SGST 9%; other state → IGST 18%.
 */
export async function quote(planId: string, cycle: Cycle, couponCode?: string | null, buyerState?: string | null, userId?: string) {
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  if (!plan || !plan.active || plan.isFree) throw notFound('Plan');
  const price = await db.query.planPrices.findFirst({ where: and(eq(planPrices.planId, planId), eq(planPrices.cycle, cycle)) });
  if (!price || !price.enabled) throw badRequest('This billing period isn’t available for this plan');
  let discount = 0;
  let couponError: string | undefined;
  let coupon: typeof coupons.$inferSelect | undefined;
  if (couponCode) {
    const r = await checkCoupon(couponCode, planId, cycle, userId);
    if (r.error) couponError = r.error;
    else {
      coupon = r.coupon!;
      discount = coupon.percent ? Math.round((price.price * coupon.percent) / 100) : Math.min(coupon.amountOff ?? 0, price.price);
    }
  }
  const taxable = price.price - discount;
  const gst = Math.round((taxable * GST_RATE) / 100);
  const biz = (await paymentSettings()).business;
  const intra = !!buyerState && !!biz.state && buyerState.trim().toLowerCase() === biz.state.trim().toLowerCase();
  return {
    plan: { id: plan.id, name: plan.name }, cycle, months: CYCLE_MONTHS[cycle],
    base: price.price, discount, taxable, gst,
    gstSplit: intra ? { cgst: Math.floor(gst / 2), sgst: gst - Math.floor(gst / 2), igst: 0 } : { cgst: 0, sgst: 0, igst: gst },
    amount: taxable + gst,
    coupon: coupon ? { code: coupon.code, note: coupon.note, percent: coupon.percent, amountOff: coupon.amountOff } : null,
    couponError,
  };
}

/** Indian financial year (Apr–Mar), e.g. 2026-27. */
export function fy(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** Next invoice number like CH-INV-2026-27/00042 (sequential per financial year, as GST requires). */
export async function nextInvoiceNo() {
  const prefix = `${(await paymentSettings()).business.invoicePrefix || 'CH-INV-'}${fy()}/`;
  const [last] = await db.select({ no: payments.invoiceNo }).from(payments).where(like(payments.invoiceNo, `${prefix}%`)).orderBy(sql`${payments.invoiceNo} DESC`).limit(1);
  const n = last?.no ? Number(last.no.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(5, '0')}`;
}

const addMonths = (d: Date, m: number) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };

/**
 * Marks a payment successful and turns on the plan. Safe to call twice (webhook + browser):
 * only the first call that flips CREATED/FAILED → SUCCESS does anything.
 */
export async function markPaid(paymentId: string, info: { gatewayPaymentId?: string | null; method?: string | null }) {
  const p = await db.query.payments.findFirst({ where: eq(payments.id, paymentId) });
  if (!p) throw notFound('Payment');
  if (p.status !== 'CREATED' && p.status !== 'FAILED') return { payment: p, activated: false };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const invoiceNo = await nextInvoiceNo();
      const [paid] = await db.update(payments).set({ status: 'SUCCESS', gatewayPaymentId: info.gatewayPaymentId ?? p.gatewayPaymentId, method: info.method ?? p.method, paidAt: new Date(), invoiceNo })
        .where(and(eq(payments.id, p.id), sql`${payments.status} IN ('CREATED','FAILED')`)).returning();
      if (!paid) return { payment: (await db.query.payments.findFirst({ where: eq(payments.id, p.id) }))!, activated: false };
      await activate(paid);
      return { payment: paid, activated: true };
    } catch (e) {
      if ((e as { code?: string }).code === '23505' && attempt < 2) continue; // invoice number taken by a parallel payment
      throw e;
    }
  }
  throw new Error('Could not assign invoice number');
}

async function activate(p: typeof payments.$inferSelect) {
  const u = (await db.query.users.findFirst({ where: eq(users.id, p.userId) }))!;
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, p.planId) });
  const now = new Date();
  const from = u.planId === p.planId && u.planUntil && u.planUntil > now ? u.planUntil : now;
  let until = addMonths(from, CYCLE_MONTHS[p.cycle]);
  if (u.bonusDays > 0) until = new Date(until.getTime() + u.bonusDays * 86_400_000);
  await db.update(users).set({ planId: p.planId, planCycle: p.cycle, planUntil: until, bonusDays: 0, autoRenew: true }).where(eq(users.id, u.id));
  if (p.couponCode) await db.update(coupons).set({ used: sql`${coupons.used} + 1` }).where(eq(coupons.code, p.couponCode));
  await notifyRule('payment_receipt', u.id, { amount: rupees(p.amount), invoice: p.invoiceNo, plan: plan?.name }, '/my-plan');
  await rewardReferrer(u, p.id);
}

/** First paid plan of a referred member → the person who invited them gets 7 free Pro days. */
const REFERRAL_DAYS = 7;
async function rewardReferrer(u: User, paymentId: string) {
  if (!u.referredById) return;
  const [{ n }] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(payments).where(and(eq(payments.userId, u.id), eq(payments.status, 'SUCCESS')));
  if (n !== 1) return;
  const ref = await db.query.users.findFirst({ where: eq(users.id, u.referredById) });
  if (!ref || ref.status !== 'ACTIVE') return;
  const paid = ref.planId !== 'free' && ref.planUntil && ref.planUntil > new Date();
  if (paid) await db.update(users).set({ planUntil: new Date(ref.planUntil!.getTime() + REFERRAL_DAYS * 86_400_000) }).where(eq(users.id, ref.id));
  else await db.update(users).set({ bonusDays: sql`${users.bonusDays} + ${REFERRAL_DAYS}` }).where(eq(users.id, ref.id));
  await notify(ref.id, 'referral', `You earned ${REFERRAL_DAYS} free Pro days 🎉`, `${u.name || 'Someone you invited'} just went Pro.${paid ? ' We added the days to your plan.' : ' They will be added when you go Pro.'}`, '/my-plan');
  logger.info({ referrer: ref.id, paymentId }, 'referral reward');
}

export async function markFailed(paymentId: string, reason: string) {
  await db.update(payments).set({ status: 'FAILED', failureReason: reason.slice(0, 300) }).where(and(eq(payments.id, paymentId), eq(payments.status, 'CREATED')));
}
