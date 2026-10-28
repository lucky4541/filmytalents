import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { kycLinkOk } from './lib/storage';
import { logger } from './lib/logger';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/error';
import { pool } from './db';
import { registerRoutes } from './routes';
import { provider } from './lib/sms';
import { maintenanceGate } from './middleware/maintenance';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Payment webhooks need the raw body to check signatures, so they are mounted before express.json().
  app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '1mb' }));

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || origins.includes(origin)), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  // ID documents: only with a fresh signed link (see signKycUrl), never cached.
  app.use('/uploads/kyc', (req, res, next) => {
    if (!kycLinkOk(`/kyc${decodeURIComponent(req.path)}`, req.query.exp, req.query.sig)) { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This document link has expired or is not allowed' } }); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  }, express.static(path.resolve(env.UPLOAD_DIR, 'kyc'), { index: false, cacheControl: false, dotfiles: 'deny' }));
  app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR), { maxAge: '7d', index: false }));

  app.get('/health', async (_req, res) => {
    let db = 'ok';
    try { await pool.query('SELECT 1'); } catch { db = 'down'; }
    res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', db, time: new Date().toISOString(), otpProvider: await provider().catch(() => env.OTP_PROVIDER) });
  });

  app.use('/api/v1', apiLimiter);
  app.use('/api/v1', maintenanceGate);
  registerRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
