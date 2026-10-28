import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { isProd } from '../config/env';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message } });
  }
  const pg = err as { code?: string };
  if (pg?.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'This already exists' } });
  if (pg?.code === '23503') return res.status(400).json({ error: { code: 'BAD_REFERENCE', message: 'A linked item does not exist' } });
  if (pg?.code === '22P02') return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid value' } });
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
  }
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: isProd ? 'Something went wrong. Please try again.' : String((err as Error)?.message ?? err) } });
}
