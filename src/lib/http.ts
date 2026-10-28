import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { badRequest } from './errors';

/** Wraps async route handlers so thrown errors reach the error middleware. */
export const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res, next).catch(next);
};

/** Validates and returns req.body / req.query with a zod schema. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input', r.error.flatten());
  }
  return r.data;
}

export function paging(q: { page?: unknown; limit?: unknown }, max = 100) {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(max, Math.max(1, Number(q.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export const pageResult = <T>(items: T[], total: number, page: number, limit: number) => ({ items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
