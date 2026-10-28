import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import * as schema from './schema';

export const pool = new Pool({ connectionString: env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX ?? 10) });
export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
