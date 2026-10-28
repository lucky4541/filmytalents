import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export type TokenKind = 'member' | 'admin';
export interface AccessPayload { sub: string; kind: TokenKind; role?: string }

export const signAccess = (p: AccessPayload) => jwt.sign(p, env.JWT_ACCESS_SECRET, { expiresIn: `${env.ACCESS_TOKEN_MINUTES}m` });
export const verifyAccess = (token: string) => jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload & { exp: number };
