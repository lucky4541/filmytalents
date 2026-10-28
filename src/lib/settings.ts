import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { decrypt, encrypt } from './crypto';

const cache = new Map<string, { at: number; value: unknown }>();

/** Reads a plain setting with a 30-second cache. */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value as T;
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) });
  const value = (row?.value as T) ?? fallback;
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function setSetting(key: string, value: unknown, by?: string) {
  await db.insert(schema.settings).values({ key, value, updatedBy: by }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedBy: by, updatedAt: new Date() } });
  cache.delete(key);
}

/** Secrets are write-only from the API; only the last 4 characters (hint) are returned. */
export async function setSecret(key: string, plain: string, by?: string) {
  const row = { key, cipher: encrypt(plain), hint: plain.slice(-4), updatedBy: by };
  await db.insert(schema.secretSettings).values(row).onConflictDoUpdate({ target: schema.secretSettings.key, set: { cipher: row.cipher, hint: row.hint, updatedBy: by, updatedAt: new Date() } });
  cache.delete(`secret:${key}`);
}

export async function getSecret(key: string): Promise<string | null> {
  const hit = cache.get(`secret:${key}`);
  if (hit && Date.now() - hit.at < 30_000) return hit.value as string | null;
  const row = await db.query.secretSettings.findFirst({ where: eq(schema.secretSettings.key, key) });
  const value = row ? decrypt(row.cipher) : null;
  cache.set(`secret:${key}`, { at: Date.now(), value });
  return value;
}

export async function secretHints(): Promise<Record<string, string>> {
  const rows = await db.select({ key: schema.secretSettings.key, hint: schema.secretSettings.hint }).from(schema.secretSettings);
  return Object.fromEntries(rows.map((r) => [r.key, r.hint]));
}

export const clearSettingsCache = () => cache.clear();
