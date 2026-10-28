import type { Request } from 'express';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, schema } from '../../db';
import { env } from '../../config/env';
import { randomToken, sha256 } from '../../lib/crypto';
import { signAccess, type TokenKind } from '../../lib/jwt';
import { unauthorized } from '../../lib/errors';

const { refreshTokens } = schema;

/** Issues a short-lived access token and a long-lived refresh token (stored hashed). */
export async function issueTokens(req: Request, kind: TokenKind, id: string, role?: string) {
  const refresh = randomToken(32);
  await db.insert(refreshTokens).values({
    tokenHash: sha256(refresh),
    userId: kind === 'member' ? id : null,
    adminId: kind === 'admin' ? id : null,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86_400_000),
    userAgent: req.get('user-agent')?.slice(0, 200),
    ip: req.ip,
  });
  return { accessToken: signAccess({ sub: id, kind, role }), refreshToken: refresh, expiresIn: env.ACCESS_TOKEN_MINUTES * 60 };
}

/** Swaps a refresh token for a new pair (the old one stops working). */
export async function rotate(req: Request, refresh: string, kind: TokenKind) {
  const row = await db.query.refreshTokens.findFirst({ where: and(eq(refreshTokens.tokenHash, sha256(refresh)), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())) });
  const ownerId = kind === 'member' ? row?.userId : row?.adminId;
  if (!row || !ownerId) throw unauthorized('Please log in again');
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
  return { ownerId, tokens: null as null | Awaited<ReturnType<typeof issueTokens>> };
}

export async function revoke(refresh: string) {
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, sha256(refresh)));
}

export async function revokeAllFor(kind: TokenKind, id: string) {
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(kind === 'member' ? eq(refreshTokens.userId, id) : eq(refreshTokens.adminId, id), isNull(refreshTokens.revokedAt)));
}
