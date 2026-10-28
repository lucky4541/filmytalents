/** Errors thrown on purpose. The message is safe to show to the user. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR', public details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, 'BAD_REQUEST', details);
export const unauthorized = (msg = 'Please log in again') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'You don’t have access to this') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (what = 'Item') => new HttpError(404, `${what} not found`, 'NOT_FOUND');
export const conflict = (msg: string) => new HttpError(409, msg, 'CONFLICT');
export const tooMany = (msg: string) => new HttpError(429, msg, 'TOO_MANY_REQUESTS');
export const paymentRequired = (msg: string) => new HttpError(402, msg, 'PRO_REQUIRED');
