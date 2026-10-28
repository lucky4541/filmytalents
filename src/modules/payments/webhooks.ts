import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { ah } from '../../lib/http';
import { logger } from '../../lib/logger';
import { verifyCashfreeWebhook, verifyRazorpayWebhook } from './gateways';
import { markFailed, markPaid } from './service';

/**
 * Gateways call these when a payment finishes, even if the member closed the app.
 * Razorpay webhook URL: <API>/api/v1/webhooks/razorpay   (events: payment.captured, order.paid, payment.failed, refund.processed)
 * Cashfree webhook URL: <API>/api/v1/webhooks/cashfree   (PAYMENT_SUCCESS / PAYMENT_FAILED / REFUND_STATUS)
 */
const router = Router();
const { payments } = schema;

const byOrder = (orderId: string) => db.query.payments.findFirst({ where: eq(payments.gatewayOrderId, orderId) });

router.post('/razorpay', ah(async (req, res) => {
  const raw = req.body as Buffer;
  if (!(await verifyRazorpayWebhook(raw, req.header('x-razorpay-signature')))) {
    logger.warn('razorpay webhook: bad signature');
    return res.status(400).json({ ok: false });
  }
  const evt = JSON.parse(raw.toString('utf8')) as { event: string; payload: Record<string, { entity: Record<string, unknown> }> };
  const pay = evt.payload.payment?.entity;
  const orderId = (pay?.order_id ?? evt.payload.order?.entity?.id) as string | undefined;
  if ((evt.event === 'payment.captured' || evt.event === 'order.paid') && orderId) {
    const p = await byOrder(orderId);
    if (p) await markPaid(p.id, { gatewayPaymentId: pay?.id as string, method: pay?.method as string });
  } else if (evt.event === 'payment.failed' && orderId) {
    const p = await byOrder(orderId);
    if (p) await markFailed(p.id, String(pay?.error_description ?? 'Payment failed'));
  } else if (evt.event === 'refund.processed') {
    const r = evt.payload.refund?.entity;
    const p = r ? await db.query.payments.findFirst({ where: eq(payments.gatewayPaymentId, String(r.payment_id)) }) : undefined;
    if (p && !p.refundedAt) await db.update(payments).set({ refundedAt: new Date() }).where(eq(payments.id, p.id));
  }
  res.json({ ok: true });
}));

router.post('/cashfree', ah(async (req, res) => {
  const raw = req.body as Buffer;
  if (!(await verifyCashfreeWebhook(raw, req.header('x-webhook-signature'), req.header('x-webhook-timestamp')))) {
    logger.warn('cashfree webhook: bad signature');
    return res.status(400).json({ ok: false });
  }
  const evt = JSON.parse(raw.toString('utf8')) as { type: string; data: { order?: { order_id: string }; payment?: { cf_payment_id: number | string; payment_group?: string; payment_message?: string }; refund?: { order_id: string; refund_status: string } } };
  const orderId = evt.data.order?.order_id ?? evt.data.refund?.order_id;
  const p = orderId ? await byOrder(orderId) : undefined;
  if (p) {
    if (evt.type.startsWith('PAYMENT_SUCCESS')) await markPaid(p.id, { gatewayPaymentId: String(evt.data.payment?.cf_payment_id ?? ''), method: evt.data.payment?.payment_group });
    else if (evt.type.startsWith('PAYMENT_FAILED') || evt.type.startsWith('PAYMENT_USER_DROPPED')) await markFailed(p.id, evt.data.payment?.payment_message ?? 'Payment failed');
    else if (evt.type.startsWith('REFUND_STATUS') && evt.data.refund?.refund_status === 'SUCCESS' && !p.refundedAt) await db.update(payments).set({ refundedAt: new Date() }).where(eq(payments.id, p.id));
  }
  res.json({ ok: true });
}));

export default router;
