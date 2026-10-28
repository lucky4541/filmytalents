import type { NextFunction, Request, Response } from 'express';
import { getSetting } from '../lib/settings';

/** Paths that keep working while the app is in maintenance mode. */
const OPEN = ['/admin', '/site', '/webhooks', '/share'];

/** Admin → Settings → Maintenance: members see a message; admins and payment webhooks keep working. */
export async function maintenanceGate(req: Request, res: Response, next: NextFunction) {
  try {
    if (OPEN.some((p) => req.path.startsWith(p))) return next();
    const m = await getSetting<{ enabled?: boolean; message?: string }>('maintenance', {});
    if (!m.enabled) return next();
    res.status(503).json({ error: { code: 'MAINTENANCE', message: m.message || 'We are upgrading the app. Please check back soon.' } });
  } catch (e) { next(e); }
}
