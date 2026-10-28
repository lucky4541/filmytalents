import { Router } from 'express';
import { and, asc, count, desc, eq, gte, ilike, lte, max, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db';
import { ah, paging, pageResult, parse } from '../../lib/http';
import { badRequest, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { getSetting, secretHints, setSecret, setSetting } from '../../lib/settings';
import { normalizePhone } from '../../lib/codes';
import { fast2smsBalance, sendTextSms, smsConfig } from '../../lib/sms';
import { isProd } from '../../config/env';
import { requireAdmin, requirePerm } from '../../middleware/auth';
import { catalogue } from './site.routes';
import { runJobs } from '../../jobs';
import { brandName } from '../../lib/brand';

const { catalogueItems, auditLogs } = schema;

/* ============================ Settings ============================ */
export const adminSettings = Router();
adminSettings.use(requireAdmin, requirePerm('settings'));

/** Editable settings groups and what they may contain. Payments live at /admin/settings/payments. */
const GROUPS = {
  general: z.object({ platformName: z.string().max(60), supportEmail: z.string().email(), whatsapp: z.string().max(20), instagram: z.string().max(60), youtube: z.string().max(60), logo: z.string().max(500), favicon: z.string().max(500) }).partial(),
  uploads: z.object({ maxPhotoMb: z.number().min(1).max(25), maxVideoMb: z.number().min(5).max(200), maxVideoSec: z.number().min(10).max(600), photosPerPost: z.number().int().min(1).max(10) }).partial(),
  features: z.object({ community: z.boolean(), videoPosts: z.boolean(), follows: z.boolean(), chat: z.boolean(), earlyAccess: z.boolean(), signups: z.boolean(), memberCastings: z.boolean() }).partial(),
  chat: z.object({ dailyLimit: z.number().int().min(1).max(1000), blockPhoneNumbers: z.boolean(), blockedWords: z.string().max(2000) }).partial(),
  maintenance: z.object({ enabled: z.boolean(), message: z.string().max(300) }).partial(),
  legal: z.object({ terms: z.string().max(50_000), privacy: z.string().max(50_000), refund: z.string().max(20_000), childSafety: z.string().max(20_000) }).partial(),
  security: z.object({ sessionTimeoutMin: z.number().int().min(5).max(1440), ipAllowlist: z.string().max(2000), loginAlerts: z.boolean() }).partial(),
  sms: z.object({ provider: z.enum(['dummy', 'fast2sms']), route: z.enum(['otp', 'dlt', 'q']), senderId: z.string().max(10), templateId: z.string().max(40) }).partial(),
} as const;
type Group = keyof typeof GROUPS;

adminSettings.get('/', ah(async (_req, res) => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(GROUPS)) out[k] = await getSetting(k, {});
  out.sms = { ...(out.sms as object), ...(await smsConfig()) };
  const hints = await secretHints();
  res.json({ ...out, secrets: { fast2smsApiKey: hints['fast2sms.apiKey'] ?? null } });
}));

adminSettings.put('/:group', ah(async (req, res) => {
  const group = req.params.group as Group;
  if (!(group in GROUPS)) throw notFound('Settings group');
  const body = parse(GROUPS[group], req.body) as Record<string, unknown>;
  if (group === 'sms') {
    if (body.provider === 'dummy' && isProd) throw badRequest('Dummy OTP can’t be turned on in production — anyone could log in with the dummy code.');
    if (body.provider === 'fast2sms' && !(await secretHints())['fast2sms.apiKey'] && !process.env.FAST2SMS_API_KEY) throw badRequest('Add the Fast2SMS API key first');
    if (body.route === 'dlt' && (!body.senderId || !body.templateId)) {
      const cur = await smsConfig();
      if (!(body.senderId ?? cur.senderId) || !(body.templateId ?? cur.templateId)) throw badRequest('The DLT route needs a sender ID and template ID');
    }
  }
  if (group === 'security' && typeof body.ipAllowlist === 'string' && body.ipAllowlist.trim()) {
    const bad = body.ipAllowlist.split(/[\s,]+/).filter(Boolean).find((ip) => !/^[\d.:a-fA-F/]+$/.test(ip));
    if (bad) throw badRequest(`“${bad}” is not an IP address`);
    if (!body.ipAllowlist.split(/[\s,]+/).includes(req.ip ?? '')) throw badRequest(`Add your own IP (${req.ip}) or you will lock yourself out`);
  }
  const cur = await getSetting<Record<string, unknown>>(group, {});
  const next = { ...cur, ...body };
  await setSetting(group, next, req.admin!.name);
  await audit(req, 'settings', `Changed ${group}: ${Object.keys(body).join(', ')}`, group);
  res.json({ [group]: next });
}));

/** Fast2SMS API key (write-only). */
adminSettings.put('/secrets/fast2sms', ah(async (req, res) => {
  const { apiKey } = parse(z.object({ apiKey: z.string().trim().min(20, 'This key looks too short').max(200) }), req.body);
  await setSecret('fast2sms.apiKey', apiKey, req.admin!.name);
  await audit(req, 'settings', 'Updated Fast2SMS API key', 'sms');
  res.json({ hint: apiKey.slice(-4), balance: await fast2smsBalance() });
}));

adminSettings.get('/sms/balance', ah(async (_req, res) => { res.json(await fast2smsBalance()); }));

adminSettings.post('/sms/test', ah(async (req, res) => {
  const { phone } = parse(z.object({ phone: z.string().max(20) }), req.body);
  const p = normalizePhone(phone);
  if (!p) throw badRequest('Enter a valid 10-digit mobile number');
  const r = await sendTextSms(p, `${await brandName()} test message. SMS is working.`);
  await audit(req, 'settings', `Sent test SMS (${r.ok ? 'ok' : 'failed'})`, `******${p.slice(-4)}`);
  res.json(r);
}));

/* ============================ Catalogue ============================ */
export const adminCatalogue = Router();
adminCatalogue.use(requireAdmin, requirePerm('catalogue'));

adminCatalogue.get('/', ah(async (_req, res) => {
  const rows = await db.select().from(catalogueItems).orderBy(asc(catalogueItems.list), asc(catalogueItems.order), asc(catalogueItems.name));
  const lists: Record<string, typeof rows> = {};
  for (const r of rows) (lists[r.list] ??= []).push(r);
  res.json({ lists });
}));

/** How many records use each value of a list (so admins hide rather than delete values in use). */
adminCatalogue.get('/usage/:list', ah(async (req, res) => {
  const q: Record<string, ReturnType<typeof sql>> = {
    crafts: sql`SELECT c AS name, count(*)::int AS n FROM users, unnest(crafts) c WHERE status <> 'DELETED' GROUP BY 1`,
    languages: sql`SELECT name, sum(n)::int AS n FROM (SELECT l AS name, count(*) n FROM users, unnest(languages) l WHERE status <> 'DELETED' GROUP BY 1 UNION ALL SELECT l, count(*) FROM castings, unnest(languages) l GROUP BY 1) x GROUP BY 1`,
    cities: sql`SELECT name, sum(n)::int AS n FROM (SELECT city AS name, count(*) n FROM users WHERE city IS NOT NULL AND status <> 'DELETED' GROUP BY 1 UNION ALL SELECT location, count(*) FROM castings GROUP BY 1) x GROUP BY 1`,
    projectTypes: sql`SELECT project_type AS name, count(*)::int AS n FROM castings GROUP BY 1`,
    reportReasons: sql`SELECT reason AS name, count(*)::int AS n FROM reports GROUP BY 1`,
  };
  const s = q[req.params.list];
  if (!s) return res.json({ usage: {} });
  const rows = (await db.execute<{ name: string; n: number }>(s)).rows;
  res.json({ usage: Object.fromEntries(rows.map((r) => [r.name, r.n])) });
}));

adminCatalogue.post('/', ah(async (req, res) => {
  const b = parse(z.object({ list: z.string().regex(/^[a-zA-Z]{2,30}$/), name: z.string().trim().min(1).max(60) }), req.body);
  const [m] = await db.select({ o: max(catalogueItems.order) }).from(catalogueItems).where(eq(catalogueItems.list, b.list));
  const [item] = await db.insert(catalogueItems).values({ ...b, order: (m.o ?? -1) + 1 }).returning();
  await audit(req, 'catalogue', `Added “${b.name}”`, b.list);
  res.status(201).json({ item });
}));

adminCatalogue.patch('/:id', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(60), active: z.boolean() }).partial(), req.body);
  const [item] = await db.update(catalogueItems).set(b).where(eq(catalogueItems.id, req.params.id)).returning();
  if (!item) throw notFound('Item');
  await audit(req, 'catalogue', `Edited “${item.name}” (${Object.keys(b).join(', ')})`, item.list);
  res.json({ item });
}));

adminCatalogue.put('/:list/order', ah(async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string()).max(500) }), req.body);
  for (const [i, id] of ids.entries()) await db.update(catalogueItems).set({ order: i }).where(and(eq(catalogueItems.id, id), eq(catalogueItems.list, req.params.list)));
  res.json({ ok: true });
}));

adminCatalogue.delete('/:id', ah(async (req, res) => {
  const [item] = await db.delete(catalogueItems).where(eq(catalogueItems.id, req.params.id)).returning();
  if (!item) throw notFound('Item');
  await audit(req, 'catalogue', `Deleted “${item.name}”`, item.list);
  res.json({ ok: true, lists: await catalogue(false) });
}));

/* ============================ Audit log ============================ */
export const adminAudit = Router();
adminAudit.use(requireAdmin, requirePerm('audit'));

const auditQuery = z.object({ module: z.string().optional(), adminId: z.string().optional(), q: z.string().trim().max(100).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), sensitive: z.enum(['true']).optional() });
/** Actions worth a second look: money, bans, roles, settings, deletions, phone reveals. */
const SENSITIVE = 'refund|ban|suspend|role|settings|gateway|key|price|delet|disabl|reset|revealed|phone|removed|anonymi';
function auditWhere(f: z.infer<typeof auditQuery>) {
  const w: SQL[] = [];
  if (f.module) w.push(eq(auditLogs.module, f.module));
  if (f.adminId) w.push(eq(auditLogs.adminId, f.adminId));
  if (f.q) w.push(or(ilike(auditLogs.action, `%${f.q}%`), ilike(auditLogs.target, `%${f.q}%`), ilike(auditLogs.actorName, `%${f.q}%`))!);
  if (f.from) w.push(gte(auditLogs.createdAt, f.from));
  if (f.to) w.push(lte(auditLogs.createdAt, f.to));
  if (f.sensitive) w.push(sql`(${auditLogs.action} ~* ${SENSITIVE} OR ${auditLogs.module} = 'settings')`);
  return w.length ? and(...w) : undefined;
}

adminAudit.get('/', ah(async (req, res) => {
  const f = parse(auditQuery, req.query);
  const { page, limit, skip } = paging(req.query, 200);
  const w = auditWhere(f);
  const [{ n }] = await db.select({ n: count() }).from(auditLogs).where(w);
  const rows = await db.select().from(auditLogs).where(w).orderBy(desc(auditLogs.createdAt)).limit(limit).offset(skip);
  const modules = await db.selectDistinct({ m: auditLogs.module }).from(auditLogs);
  const admins = await db.selectDistinct({ id: auditLogs.adminId, name: auditLogs.actorName }).from(auditLogs).where(sql`${auditLogs.adminId} IS NOT NULL`);
  const [st] = (await db.execute<{ today: number; total: number; sensitive7: number }>(sql`SELECT
    count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS today,
    count(*)::int AS total,
    count(*) FILTER (WHERE created_at > now() - interval '7 days' AND (action ~* ${SENSITIVE} OR module = 'settings'))::int AS sensitive7
    FROM audit_logs`)).rows;
  res.json({ modules: modules.map((m) => m.m).sort(), admins: admins.sort((a, b) => a.name.localeCompare(b.name)), stats: st, sensitivePattern: SENSITIVE, ...pageResult(rows, n, page, limit) });
}));

adminAudit.get('/export.csv', ah(async (req, res) => {
  const rows = await db.select().from(auditLogs).where(auditWhere(parse(auditQuery, req.query))).orderBy(desc(auditLogs.createdAt)).limit(50_000);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send('﻿' + [['Time', 'Who', 'Area', 'Action', 'Target', 'IP'].map(esc).join(','), ...rows.map((r) => [r.createdAt.toISOString(), r.actorName, r.module, r.action, r.target, r.ip].map(esc).join(','))].join('\n'));
}));

/* ============================ Jobs ============================ */
export const adminSystem = Router();
adminSystem.use(requireAdmin, requirePerm('settings'));

/** Runs the background jobs now (they also run every 10 minutes on the server). */
adminSystem.post('/jobs/run', ah(async (req, res) => {
  const r = await runJobs();
  await audit(req, 'settings', 'Ran background jobs', JSON.stringify(r).slice(0, 200));
  res.json(r);
}));

adminSystem.get('/info', ah(async (_req, res) => {
  const [{ v }] = (await db.execute<{ v: string }>(sql`SELECT version() AS v`)).rows;
  res.json({ node: process.version, uptimeSec: Math.round(process.uptime()), postgres: v.split(' ').slice(0, 2).join(' '), sms: await smsConfig(), memoryMb: Math.round(process.memoryUsage().rss / 1048576) });
}));
