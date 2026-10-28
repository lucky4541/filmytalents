import type http from 'http';
import { Server } from 'socket.io';
import { eq } from 'drizzle-orm';
import { env } from './config/env';
import { verifyAccess } from './lib/jwt';
import { logger } from './lib/logger';
import { db, schema } from './db';

/**
 * Live updates over Socket.IO (chat messages, new notifications).
 * The app connects with: io(API_URL, { auth: { token: accessToken } }).
 * Events sent to the member: "message", "notification", "read", "typing", "support:message", "support:typing", "support:ticket".
 * Admins connect the same way with an admin token and get "support:*" events for every ticket.
 */
let io: Server | null = null;

export function attachRealtime(server: http.Server) {
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  io = new Server(server, { cors: { origin: origins, credentials: true }, path: '/socket.io' });
  io.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      const p = verifyAccess(token);
      if (p.kind === 'admin') {
        const a = await db.query.admins.findFirst({ where: eq(schema.admins.id, p.sub), columns: { id: true, name: true, status: true } });
        if (!a || a.status !== 'ACTIVE') return next(new Error('unauthorized'));
        socket.data.adminId = a.id;
        socket.data.adminName = a.name;
        return next();
      }
      if (p.kind !== 'member') return next(new Error('unauthorized'));
      const u = await db.query.users.findFirst({ where: eq(schema.users.id, p.sub), columns: { id: true, status: true } });
      if (!u || u.status !== 'ACTIVE') return next(new Error('unauthorized'));
      socket.data.userId = u.id;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    if (socket.data.adminId) {
      void socket.join('admins');
      // Agent typing in a ticket → the member sees "Support is typing…".
      socket.on('support:typing', async (d: { ticketId?: string }) => {
        if (!d?.ticketId) return;
        const t = await db.query.tickets.findFirst({ where: eq(schema.tickets.id, d.ticketId), columns: { userId: true } }).catch(() => undefined);
        if (!t) return;
        io?.to(`user:${t.userId}`).emit('support:typing', { ticketId: d.ticketId, who: 'agent', name: String(socket.data.adminName ?? '').split(' ')[0] });
        socket.to('admins').emit('support:typing', { ticketId: d.ticketId, who: 'agent', name: socket.data.adminName });
      });
      return;
    }
    void socket.join(`user:${socket.data.userId}`);
    // Member typing in their own ticket → agents see "Member is typing…".
    socket.on('support:typing', async (d: { ticketId?: string }) => {
      if (!d?.ticketId) return;
      const t = await db.query.tickets.findFirst({ where: eq(schema.tickets.id, d.ticketId), columns: { userId: true } }).catch(() => undefined);
      if (t?.userId === socket.data.userId) io?.to('admins').emit('support:typing', { ticketId: d.ticketId, who: 'member' });
    });
    // Chat "typing…": only to the other person in a conversation this member is part of.
    socket.on('typing', async (d: { to?: string; conversationId?: string }) => {
      if (!d?.to || !d.conversationId) return;
      const c = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, d.conversationId), columns: { aId: true, bId: true } }).catch(() => undefined);
      const me = socket.data.userId as string;
      if (!c || !((c.aId === me && c.bId === d.to) || (c.bId === me && c.aId === d.to))) return;
      io?.to(`user:${d.to}`).emit('typing', { conversationId: d.conversationId, from: me });
    });
  });
  logger.info('Realtime (Socket.IO) ready');
  return io;
}

/** Sends an event to every open tab/app of a member. Does nothing in tests or before start. */
export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}

/** Sends an event to every connected admin (support inbox). */
export function emitToAdmins(event: string, payload: unknown) {
  io?.to('admins').emit(event, payload);
}
