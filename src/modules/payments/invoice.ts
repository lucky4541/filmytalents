import { eq } from 'drizzle-orm';
import { db, schema } from '../../db';
import { paymentSettings } from './gateways';
import { CYCLE_MONTHS, rupees } from './service';
import { brandName } from '../../lib/brand';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A simple GST tax invoice. Open in a browser and "Save as PDF". */
export async function invoiceHtml(p: typeof schema.payments.$inferSelect) {
  const biz = (await paymentSettings()).business;
  const brand = await brandName();
  const plan = await db.query.plans.findFirst({ where: eq(schema.plans.id, p.planId) });
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, p.userId) });
  const taxable = p.base - p.discount;
  const intra = !!p.billing.state && !!biz.state && p.billing.state.toLowerCase() === biz.state.toLowerCase();
  const half = Math.floor(p.gst / 2);
  const date = (p.paidAt ?? p.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const months = CYCLE_MONTHS[p.cycle];
  const row = (l: string, v: string, b = false) => `<tr${b ? ' class="b"' : ''}><td>${esc(l)}</td><td class="r">${esc(v)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${esc(p.invoiceNo)}</title>
<style>body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;background:#f5f5f5}.w{max-width:760px;margin:24px auto;background:#fff;padding:36px;border-radius:12px}
h1{font-size:20px;margin:0}.m{color:#666;font-size:12px}.g{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin:24px 0}table{width:100%;border-collapse:collapse;margin-top:12px}
td,th{padding:10px 8px;border-bottom:1px solid #eee;text-align:left}.r{text-align:right}.b td{font-weight:700;border-top:2px solid #111}.tag{display:inline-block;padding:2px 8px;border-radius:99px;background:#e7f7ee;color:#137a3d;font-size:12px;font-weight:600}
@media print{body{background:#fff}.w{margin:0;border-radius:0}.np{display:none}}</style></head><body><div class="w">
<div class="g" style="margin-top:0"><div><h1>Tax invoice</h1><div class="m">${esc(p.invoiceNo)} · ${esc(date)}</div></div><div class="r"><b>${esc(biz.legalName)}</b><div class="m">${esc(biz.address)}${biz.gstin ? `<br>GSTIN ${esc(biz.gstin)}` : ''}</div></div></div>
<div class="g"><div><div class="m">Billed to</div><b>${esc(p.billing.name ?? u?.name)}</b><div class="m">${esc(p.billing.email)}<br>${esc(p.billing.state)}${p.billing.gstin ? `<br>GSTIN ${esc(p.billing.gstin)}` : ''}<br>Member ${esc(u?.code)}</div></div>
<div class="r"><div class="m">Status</div><span class="tag">${p.status === 'SUCCESS' ? 'Paid' : esc(p.status.replace('_', ' ').toLowerCase())}</span><div class="m">${esc(p.gateway === 'RAZORPAY' ? 'Razorpay' : 'Cashfree')}${p.method ? ` · ${esc(p.method)}` : ''}<br>${esc(p.gatewayPaymentId)}</div></div></div>
<table><thead><tr><th>Description</th><th class="r">Amount</th></tr></thead><tbody>
${row(`${brand} ${plan?.name ?? p.planId} plan — ${months} month${months > 1 ? 's' : ''} (SAC ${biz.sac})`, rupees(p.base))}
${p.discount ? row(`Discount${p.couponCode ? ` (${p.couponCode})` : ''}`, `− ${rupees(p.discount)}`) : ''}
${row('Taxable value', rupees(taxable))}
${intra ? row('CGST 9%', rupees(half)) + row('SGST 9%', rupees(p.gst - half)) : row('IGST 18%', rupees(p.gst))}
${row('Total paid', rupees(p.amount), true)}
${p.refundAmount ? row('Refunded', `− ${rupees(p.refundAmount)}`) : ''}
</tbody></table>
<p class="m" style="margin-top:24px">This is a computer-generated invoice and does not need a signature. Questions? Reply from Help &amp; support in the app.</p>
<p class="np"><button onclick="print()" style="padding:10px 16px;border-radius:8px;border:0;background:#111;color:#fff;font-weight:600;cursor:pointer">Download / Print</button></p>
</div></body></html>`;
}
