import { Router } from 'express';
import * as controller from './catalog.controller.js';
import { authenticate, attachProfile } from '../../middleware/authenticate.js';
import { getProfileContext } from '../profiles/profiles.service.js';

/**
 * Catalog routes. Authentication is optional for browse/search/detail —
 * the frontend renders the catalog before sign-in — but when a token IS
 * present the profile header scopes kids mode.
 */

const router = Router();
router.use(authenticate({ optional: true }));
router.use(attachProfile(getProfileContext));

/**
 * @openapi
 * /catalog/browse:
 *   get:
 *     tags: [Catalog]
 *     summary: Paginated catalog browse with filters
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 20, maximum: 60 } }
 *       - { in: query, name: genre, schema: { type: string } }
 *       - { in: query, name: year, schema: { type: integer } }
 *       - { in: query, name: rating, schema: { type: string } }
 *       - { in: query, name: type, schema: { type: string, enum: [MOVIE, SERIES] } }
 *       - { in: query, name: sort, schema: { type: string, enum: [trending, newest, oldest, az, rating] } }
 *       - { in: query, name: q, schema: { type: string } }
 *     responses:
 *       200:
 *         description: One page of titles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items: { type: array, items: { $ref: '#/components/schemas/TitleSummary' } }
 *                 page: { type: integer }
 *                 pageSize: { type: integer }
 *                 total: { type: integer }
 *                 totalPages: { type: integer }
 */
router.get('/browse', controller.browse);

/**
 * @openapi
 * /catalog/search:
 *   get:
 *     tags: [Catalog]
 *     summary: Full-text search across titles
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: q, required: true, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: Search results page }
 *       400: { description: Empty query }
 */
router.get('/search', controller.search);

/**
 * @openapi
 * /catalog/genres:
 *   get:
 *     tags: [Catalog]
 *     summary: Distinct genres with title counts
 *     responses:
 *       200: { description: Genre list }
 */
router.get('/genres', controller.genres);

/**
 * @openapi
 * /catalog/titles/{id}:
 *   get:
 *     tags: [Catalog]
 *     summary: Title detail with nested seasons/episodes/renditions
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: Title UUID or slug }
 *     responses:
 *       200:
 *         description: Title detail
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 title: { $ref: '#/components/schemas/TitleDetail' }
 *       404: { description: Not found (or hidden by profile scope) }
 */
router.get('/titles/:id', controller.getTitle);

/**
 * @openapi
 * /catalog/titles/{id}/similar:
 *   get:
 *     tags: [Catalog]
 *     summary: Similar titles by genre/tag overlap
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, default: 8, maximum: 20 } }
 *     responses:
 *       200: { description: Ranked similar titles }
 */
router.get('/titles/:id/similar', controller.similar);

/**
 * @openapi
 * /catalog/hero:
 *   get:
 *     tags: [Catalog]
 *     summary: Featured hero banner titles
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Up to 3 featured titles }
 */
router.get('/hero', controller.hero);

export default router;
