import { Router } from 'express';
import * as controller from './watchlist.controller.js';
import { authenticate } from '../../middleware/authenticate.js';

/**
 * Watchlist routes — user-scoped (not profile-scoped).
 */

const router = Router();
router.use(authenticate());

/**
 * @openapi
 * /watchlist:
 *   get:
 *     tags: [Watchlist]
 *     summary: Paginated watchlist
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: Watchlist page }
 */
router.get('/', controller.list);

/**
 * @openapi
 * /watchlist:
 *   post:
 *     tags: [Watchlist]
 *     summary: Add a title to the watchlist
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [titleId]
 *             properties:
 *               titleId: { type: string, format: uuid }
 *     responses:
 *       201: { description: Added }
 *       409: { description: Already in watchlist }
 */
router.post('/', controller.add);

/**
 * @openapi
 * /watchlist/{titleId}:
 *   delete:
 *     tags: [Watchlist]
 *     summary: Remove a title from the watchlist
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: titleId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       204: { description: Removed }
 *       404: { description: Not in watchlist }
 */
router.delete('/:titleId', controller.remove);

/**
 * @openapi
 * /watchlist/{titleId}/check:
 *   get:
 *     tags: [Watchlist]
 *     summary: Check watchlist membership
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: titleId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Membership }
 */
router.get('/:titleId/check', controller.check);

export default router;
