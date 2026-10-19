import { Router } from 'express';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { loadEnv } from '../config/env.js';
import { getLogger } from '../lib/logger.js';

/**
 * OpenAPI plugin.
 *
 * The spec is assembled by swagger-jsdoc from the JSDoc annotations that live
 * inline on every route module (search for `@openapi` blocks). Mounted at
 * SWAGGER_PATH (default /docs).
 */

export function buildOpenApiSpec(apiUrl: string) {
  return swaggerJsdoc({
    definition: {
      openapi: '3.0.3',
      info: {
        title: 'StreamEX API',
        version: '1.0.0',
        description:
          'Backend for the StreamEX streaming platform. ' +
          'Authentication uses `Authorization: Bearer <accessToken>`; ' +
          'profile context is passed via the `X-Profile-Id` header. ' +
          'Errors use the envelope `{ "error": { code, message, details?, requestId } }`.',
      },
      servers: [{ url: apiUrl }],
      tags: [
        { name: 'Auth', description: 'Registration, login, refresh rotation, password reset' },
        { name: 'Profiles', description: 'Per-user viewing profiles' },
        { name: 'Catalog', description: 'Browse, search, title details, similar titles' },
        { name: 'Playback', description: 'Signed HLS manifest + rendition selection' },
        { name: 'Progress', description: 'Watch progress heartbeats + continue watching' },
        { name: 'Watchlist', description: 'Saved titles' },
        { name: 'Uploads', description: 'Resumable chunked source uploads' },
        { name: 'Admin', description: 'Content ingestion, moderation, asset management' },
        { name: 'Realtime', description: 'Socket.io events' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
        schemas: {
          Error: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'NOT_FOUND' },
                  message: { type: 'string' },
                  details: {},
                  requestId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
      },
    },
    apis: [`${__dirname}/../modules/**/*.routes.js`, `${__dirname}/../modules/**/*.routes.ts`],
  });
}

export function swaggerRouter(): Router {
  const router = Router();
  const env = loadEnv();
  if (!env.SWAGGER_ENABLED) {
    return router;
  }
  try {
    const spec = buildOpenApiSpec(env.API_URL);
    router.get('/openapi.json', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(spec);
    });
    router.use(
      '/',
      swaggerUi.serve,
      swaggerUi.setup(spec, {
        customCss: '.swagger-ui .topbar { display: none }',
        swaggerOptions: { persistAuthorization: true },
      }),
    );
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : err },
      'swagger init failed — /docs disabled',
    );
  }
  return router;
}
