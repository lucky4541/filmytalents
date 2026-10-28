import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env';
import { verifyAccess } from '../lib/jwt';

const skip = () => isTest;
const handler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please wait a minute and try again.' } });

/**
 * Signed-in people are counted per account, not per IP: in India many mobile users share one IP (carrier NAT),
 * so a per-IP limit would block whole groups of members. Visitors are still counted per IP.
 */
function key(req: Request) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try { return `u:${verifyAccess(h.slice(7)).sub}`; } catch { /* expired or bad token: fall back to IP */ }
  }
  return `ip:${req.ip ?? ''}`;
}

export const apiLimiter = rateLimit({ windowMs: 60_000, limit: (req) => (key(req).startsWith('u:') ? 600 : 300), keyGenerator: key, standardHeaders: true, legacyHeaders: false, skip, handler });
export const authLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, skip, handler });
