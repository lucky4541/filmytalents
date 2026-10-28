import { Router } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db';
import { ah } from '../../lib/http';
import { getSetting } from '../../lib/settings';
import { isPaid, optionalMember } from '../../middleware/auth';
import { publicUser } from '../../lib/serialize';
import { publicCasting, rolesFor } from '../castings/service';

const { catalogueItems, castings, users } = schema;

/** Lists used by forms and filters (crafts, languages, cities, project types, report reasons …). */
export async function catalogue(activeOnly = true) {
  const rows = await db.select().from(catalogueItems).where(activeOnly ? eq(catalogueItems.active, true) : undefined).orderBy(asc(catalogueItems.list), asc(catalogueItems.order), asc(catalogueItems.name));
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.list] ??= []).push(r.name);
  return out;
}

type Banner = { id: string; audience?: string; startsAt?: string | null; endsAt?: string | null; active?: boolean };

/**
 * Everything the member app needs on start: branding, feature switches, home page content,
 * announcement bar, banners for this viewer (visitor / Free / Pro), catalogue lists and legal text.
 */
export const site = Router();

site.get('/', optionalMember, ah(async (req, res) => {
  const [general, features, home, maintenance, legal, uploads, lists] = await Promise.all([
    getSetting<Record<string, unknown>>('general', {}),
    getSetting<Record<string, boolean>>('features', {}),
    getSetting<{ banners?: Banner[]; featuredCastings?: string[]; featuredTalent?: string[]; [k: string]: unknown }>('home', {}),
    getSetting<{ enabled?: boolean; message?: string }>('maintenance', {}),
    getSetting<Record<string, string>>('legal', {}),
    getSetting<Record<string, number>>('uploads', {}),
    catalogue(),
  ]);
  const who = !req.user ? 'visitors' : isPaid(req.user) ? 'paid' : 'free';
  const now = Date.now();
  const banners = (home.banners ?? []).filter((b) => b.active !== false && (!b.audience || b.audience === 'all' || b.audience === who)
    && (!b.startsAt || Date.parse(b.startsAt) <= now) && (!b.endsAt || Date.parse(b.endsAt) >= now));

  const fc = home.featuredCastings?.length ? await db.select().from(castings).where(and(inArray(castings.id, home.featuredCastings), eq(castings.status, 'LIVE'))) : [];
  const roles = await rolesFor(fc.map((c) => c.id));
  const ft = home.featuredTalent?.length ? await db.select().from(users).where(and(inArray(users.id, home.featuredTalent), eq(users.status, 'ACTIVE'))) : [];
  const latest = await db.select().from(castings).where(eq(castings.status, 'LIVE')).orderBy(desc(castings.featured), desc(castings.publishedAt)).limit(6);
  const latestRoles = await rolesFor(latest.map((c) => c.id));

  res.json({
    general, features, maintenance, legal, uploads, catalogue: lists,
    home: { ...home, banners, featuredCastings: fc.map((c) => publicCasting(c, roles.get(c.id) ?? [], req.user)), featuredTalent: ft.map(publicUser), latestCastings: latest.map((c) => publicCasting(c, latestRoles.get(c.id) ?? [], req.user)) },
    viewer: who,
  });
}));

site.get('/catalogue', ah(async (_req, res) => { res.json(await catalogue()); }));
site.get('/legal/:key', ah(async (req, res) => {
  const legal = await getSetting<Record<string, string>>('legal', {});
  res.json({ key: req.params.key, text: legal[req.params.key] ?? '' });
}));
