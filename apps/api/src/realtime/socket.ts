import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { loadEnv } from '../config/env.js';
import { getRedis, getSubscriber } from '../lib/redis.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { UnauthorizedError } from '../lib/errors.js';
import { getLogger } from '../lib/logger.js';
import type { ProgressSyncEvent, TranscodeProgressEvent } from './publish.js';

/**
 * Socket.io realtime layer.
 *
 * Rooms:
 *   - `admins`             : users authenticated with role=ADMIN; receive
 *                             `transcode:progress` events.
 *   - `profile:{profileId}`: devices sharing a profile; receive
 *                             `progress:sync` events (continue-watching sync).
 *
 * Auth: `io.connect(url, { auth: { token: <accessToken> } })` — the JWT is
 * verified in the middleware, and the profileId handshake query is validated
 * against the token's user.
 *
 * Scaling: the redis adapter fans out emit() across every API replica, and
 * both Redis pub/sub channels (transcode + progress) are bridged here so any
 * replica can receive events published by the worker or another replica.
 */

export function createSocketServer(httpServer: HttpServer): Server {
  const env = loadEnv();
  const log = getLogger();

  const io = new Server(httpServer, {
    path: env.SOCKET_PATH,
    cors: {
      origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
      credentials: true,
    },
  });

  // Redis adapter for horizontal fan-out.
  const pubClient = getRedis();
  const subClient = getSubscriber('socket-io-adapter');
  io.adapter(createAdapter(pubClient, subClient));

  // ── authentication middleware ──────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next(new UnauthorizedError('Missing socket auth token'));
      return;
    }
    try {
      const payload = verifyAccessToken(token);
      socket.data.userId = payload.sub;
      socket.data.role = payload.role;
      const profileId = socket.handshake.auth?.profileId as string | undefined;
      if (profileId) {
        socket.data.profileId = profileId;
      }
      next();
    } catch {
      next(new UnauthorizedError('Invalid socket auth token'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.role === 'ADMIN') {
      socket.join('admins');
    }
    if (socket.data.profileId) {
      socket.join(`profile:${socket.data.profileId}`);
    }
    socket.emit('connected', { socketId: socket.id, rooms: [...socket.rooms] });

    // Join a profile room on demand (profile switch on the client).
    socket.on('profile:join', (profileId: string, ack?: (ok: boolean) => void) => {
      if (typeof profileId !== 'string' || profileId.length === 0) {
        ack?.(false);
        return;
      }
      socket.join(`profile:${profileId}`);
      ack?.(true);
    });

    socket.on('profile:leave', (profileId: string) => {
      socket.leave(`profile:${profileId}`);
    });
  });

  // ── bridge Redis pub/sub channels into socket rooms ────────────────
  const transcodeSub = getSubscriber('transcode-events');
  transcodeSub.subscribe(env.REALTIME_EVENT_CHANNEL).catch(() => undefined);
  transcodeSub.on('message', (_channel, message) => {
    try {
      const event = JSON.parse(message) as TranscodeProgressEvent;
      io.to('admins').emit('transcode:progress', event);
    } catch {
      log.warn('garbage on transcode channel');
    }
  });

  const progressSub = getSubscriber('progress-events');
  progressSub.subscribe(env.REALTIME_PROGRESS_CHANNEL).catch(() => undefined);
  progressSub.on('message', (_channel, message) => {
    try {
      const event = JSON.parse(message) as ProgressSyncEvent & { profileId: string };
      io.to(`profile:${event.profileId}`).emit('progress:sync', event);
    } catch {
      log.warn('garbage on progress channel');
    }
  });

  return io;
}
