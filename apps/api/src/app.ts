import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { cookieParser } from './lib/cookieParser.js';
import { loadEnv, corsOrigins } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { initLogger } from './lib/logger.js';
import { swaggerRouter } from './plugins/swagger.js';

import authRoutes from './modules/auth/auth.routes.js';
import profilesRoutes from './modules/profiles/profiles.routes.js';
import catalogRoutes from './modules/catalog/catalog.routes.js';
import playbackRoutes from './modules/playback/playback.routes.js';
import progressRoutes from './modules/progress/progress.routes.js';
import watchlistRoutes from './modules/watchlist/watchlist.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import uploadRoutes from './modules/upload/upload.routes.js';
import hlsRoutes from './routes/hls.routes.js';

/**
 * Express application factory.
 *
 * Middleware order matters:
 *   requestId → helmet → cors → cookieParser → raw-body (upload routes) →
 *   global rate limit → routes → 404 → errorHandler
 */

export function createApp(): Express {
  const env = loadEnv();
  initLogger({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY, env: env.NODE_ENV });

  const app = express();

  // Behind nginx / a load balancer — trust X-Forwarded-For for req.ip.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Healthchecks first — no rate limit, no auth.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'streamex-api', time: new Date().toISOString() });
  });
  app.get('/ready', async (_req, res) => {
    // Lightweight readiness: can we reach Postgres?
    try {
      const { getPrisma } = await import('./lib/prisma.js');
      await getPrisma().$queryRaw`SELECT 1`;
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not-ready' });
    }
  });

  app.use(requestId());
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        const list = corsOrigins(env);
        if (!origin || list.test(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Global limiter applied per-route-group (auth routes use the strict one).
  app.use(globalLimiter());

  // ── routes ─────────────────────────────────────────────────────────
  app.use('/auth', authRoutes);
  app.use('/profiles', profilesRoutes);
  app.use('/catalog', catalogRoutes);
  app.use('/playback', playbackRoutes);
  app.use('/progress', progressRoutes);
  app.use('/watchlist', watchlistRoutes);
  app.use('/admin', adminRoutes);
  app.use('/upload', uploadRoutes);
  app.use(`/${env.HLS_SEGMENT_PREFIX}`, hlsRoutes);

  // Swagger / OpenAPI
  app.use(env.SWAGGER_PATH, swaggerRouter());

  // 404 + centralized error handler
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
