import type { Request } from 'express';
import { db, schema } from '../db';

/** Writes one audit-log row for an admin action. Never include secrets in `action` or `target`. */
export async function audit(req: Request, module: string, action: string, target = '') {
  const admin = req.admin;
  await db.insert(schema.auditLogs).values({ adminId: admin?.id ?? null, actorName: admin?.name ?? (req.user ? `Member ${req.user.code}` : 'System'), module, action, target: target.slice(0, 300), ip: req.ip });
}
