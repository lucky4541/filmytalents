import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { ah, parse } from '../../lib/http';
import { requireAdmin, requirePerm } from '../../middleware/auth';

/**
 * Admin dashboard + analytics. All money in paise, all days in India time (Asia/Kolkata).
 * One SQL per block keeps this fast on a single small server.
 */
export const dashboard = Router();
dashboard.use(requireAdmin, requirePerm('dashboard'));

const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) => (await db.execute<T>(q)).rows[0];
const many = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) => (await db.execute<T>(q)).rows;
const IST_TODAY = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
const IST_MONTH = sql`(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

dashboard.get('/', ah(async (_req, res) => {
  const members = await one(sql`SELECT
      count(*) FILTER (WHERE status <> 'DELETED')::int AS total,
      count(*) FILTER (WHERE created_at >= ${IST_TODAY})::int AS "newToday",
      count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS "new7d",
      count(*) FILTER (WHERE plan_id <> 'free' AND (plan_until IS NULL OR plan_until > now()))::int AS pro,
      count(*) FILTER (WHERE last_active_at > now() - interval '1 day')::int AS "activeToday",
      count(*) FILTER (WHERE verified)::int AS verified
    FROM users`);
  const money = await one(sql`SELECT
      coalesce(sum(amount) FILTER (WHERE paid_at >= ${IST_TODAY}), 0)::bigint AS today,
      coalesce(sum(amount) FILTER (WHERE paid_at >= ${IST_MONTH}), 0)::bigint AS month,
      coalesce(sum(refund_amount) FILTER (WHERE paid_at >= ${IST_MONTH}), 0)::bigint AS "refundedMonth"
    FROM payments WHERE status IN ('SUCCESS','REFUNDED','PARTIAL_REFUND')`);
  const work = await one(sql`SELECT
      (SELECT count(*) FROM castings WHERE status = 'LIVE')::int AS "liveCastings",
      (SELECT count(*) FROM castings WHERE status = 'PENDING')::int AS "castingApprovals",
      (SELECT count(*) FROM verification_requests WHERE status = 'PENDING')::int AS "verificationPending",
      (SELECT count(*) FROM reports WHERE status = 'OPEN')::int AS "openReports",
      (SELECT count(*) FROM reports WHERE status = 'OPEN' AND priority = 'urgent')::int AS "urgentReports",
      (SELECT count(*) FROM chat_reports WHERE status = 'OPEN')::int AS "chatReports",
      (SELECT count(*) FROM tickets WHERE status IN ('open','pending'))::int AS "openTickets",
      (SELECT count(*) FROM data_requests WHERE status = 'pending')::int AS "dataRequests",
      (SELECT count(*) FROM applications WHERE created_at >= ${IST_TODAY})::int AS "applicationsToday",
      (SELECT count(*) FROM castings WHERE status = 'LIVE' AND deadline < now() + interval '2 days')::int AS "closingSoon"`);
  const trend = await many(sql`WITH d AS (SELECT generate_series(0, 13) AS i), days AS (SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - (i || ' days')::interval)::date AS day FROM d)
    SELECT to_char(day, 'YYYY-MM-DD') AS day,
      (SELECT count(*) FROM users u WHERE (u.created_at AT TIME ZONE 'Asia/Kolkata')::date = day)::int AS signups,
      (SELECT count(*) FROM applications a WHERE (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = day)::int AS applications,
      (SELECT coalesce(sum(amount), 0) FROM payments p WHERE p.status IN ('SUCCESS','REFUNDED','PARTIAL_REFUND') AND (p.paid_at AT TIME ZONE 'Asia/Kolkata')::date = day)::bigint AS revenue
    FROM days ORDER BY day`);
  const topCastings = await many(sql`SELECT c.id, c.code, c.title, c.deadline, c.views, count(a.id)::int AS applicants,
      count(a.id) FILTER (WHERE a.status = 'APPLIED')::int AS unseen
    FROM castings c LEFT JOIN applications a ON a.casting_id = c.id WHERE c.status = 'LIVE' GROUP BY c.id ORDER BY applicants DESC LIMIT 5`);
  res.json({ members, money: { today: Number(money.today), month: Number(money.month), refundedMonth: Number(money.refundedMonth) }, work, trend: trend.map((t) => ({ ...t, revenue: Number(t.revenue) })), topCastings });
}));

/** Deeper numbers for the Analytics page. ?days=7|30|90|365 */
dashboard.get('/analytics', ah(async (req, res) => {
  const { days } = parse(z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }), req.query);
  const since = sql`now() - make_interval(days => ${days})`;
  const growth = await many(sql`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day, count(*)::int AS signups
    FROM users WHERE created_at > ${since} GROUP BY 1 ORDER BY 1`);
  const revenue = await many(sql`SELECT to_char(date_trunc('day', paid_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day, sum(amount)::bigint AS amount, count(*)::int AS payments
    FROM payments WHERE status IN ('SUCCESS','REFUNDED','PARTIAL_REFUND') AND paid_at > ${since} GROUP BY 1 ORDER BY 1`);
  const conversion = await one(sql`SELECT count(*)::int AS joined,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.status IN ('SUCCESS','REFUNDED','PARTIAL_REFUND')))::int AS paid
    FROM users u WHERE u.created_at > ${since}`);
  const byPlan = await many(sql`SELECT plan_id AS "planId", cycle, count(*)::int AS payments, sum(amount)::bigint AS amount FROM payments
    WHERE status IN ('SUCCESS','REFUNDED','PARTIAL_REFUND') AND paid_at > ${since} GROUP BY 1, 2 ORDER BY amount DESC`);
  const cities = await many(sql`SELECT coalesce(nullif(city, ''), 'Not set') AS city, count(*)::int AS members FROM users WHERE status = 'ACTIVE' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
  const crafts = await many(sql`SELECT craft, count(*)::int AS members FROM users, unnest(crafts) AS craft WHERE status = 'ACTIVE' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
  const funnel = await many(sql`SELECT status, count(*)::int AS n FROM applications WHERE created_at > ${since} GROUP BY 1`);
  const castingsBySource = await one(sql`SELECT count(*) FILTER (WHERE posted_by_user_id IS NULL)::int AS admin, count(*) FILTER (WHERE posted_by_user_id IS NOT NULL)::int AS member,
      count(*) FILTER (WHERE posted_by_user_id IS NOT NULL AND status = 'REJECTED')::int AS "memberRejected" FROM castings WHERE created_at > ${since}`);
  const perCasting = await one(sql`SELECT coalesce(round(avg(n)), 0)::int AS avg FROM (SELECT count(*) AS n FROM applications WHERE created_at > ${since} GROUP BY casting_id) t`);
  const coupons = await many(sql`SELECT coupon_code AS code, count(*)::int AS uses, sum(discount)::bigint AS discount FROM payments
    WHERE coupon_code IS NOT NULL AND status IN ('SUCCESS','REFUNDED','PARTIAL_REFUND') AND paid_at > ${since} GROUP BY 1 ORDER BY 2 DESC`);
  const gateways = await many(sql`SELECT gateway, count(*) FILTER (WHERE status <> 'CREATED')::int AS attempts, count(*) FILTER (WHERE status IN ('SUCCESS','REFUNDED','PARTIAL_REFUND'))::int AS success
    FROM payments WHERE created_at > ${since} GROUP BY 1`);
  const retention = await one(sql`SELECT count(*) FILTER (WHERE created_at < now() - interval '30 days')::int AS "olderThan30d",
      count(*) FILTER (WHERE created_at < now() - interval '30 days' AND last_active_at > now() - interval '30 days')::int AS "activeLast30d" FROM users WHERE status = 'ACTIVE'`);
  const num = (r: Record<string, unknown>[]) => r.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'string' && /^\d+$/.test(v) && k !== 'day' ? Number(v) : v])));
  res.json({
    days, growth, revenue: num(revenue), byPlan: num(byPlan), cities, crafts, coupons: num(coupons), gateways,
    conversion: { ...conversion, rate: conversion.joined ? Math.round(((conversion.paid as number) / (conversion.joined as number)) * 1000) / 10 : 0 },
    funnel: Object.fromEntries(funnel.map((f) => [f.status, f.n])), castingsBySource, avgApplicantsPerCasting: perCasting.avg,
    retention: { ...retention, rate: retention.olderThan30d ? Math.round(((retention.activeLast30d as number) / (retention.olderThan30d as number)) * 100) : null },
  });
}));
