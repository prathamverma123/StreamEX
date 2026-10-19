import { Router } from 'express';
import * as controller from './progress.controller.js';
import { authenticate, attachProfile } from '../../middleware/authenticate.js';
import { getProfileContext } from '../profiles/profiles.service.js';

/**
 * Watch-progress routes — always authenticated + profile-scoped.
 */

const router = Router();
router.use(authenticate());
router.use(attachProfile(getProfileContext));

/**
 * @openapi
 * /progress/heartbeat:
 *   post:
 *     tags: [Progress]
 *     summary: Debounced watch-progress heartbeat
 *     description: Persists progress when position advanced ≥15s or ≥30s since the last write; otherwise acknowledges without touching the database.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: header, name: X-Profile-Id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [titleId, positionSeconds, durationSeconds]
 *             properties:
 *               titleId: { type: string, format: uuid }
 *               episodeId: { type: string, format: uuid }
 *               positionSeconds: { type: number }
 *               durationSeconds: { type: number }
 *     responses:
 *       200: { description: Heartbeat acknowledged (persisted true/false) }
 *       401: { description: Not authenticated or missing profile }
 */
router.post('/heartbeat', controller.heartbeat);

/**
 * @openapi
 * /progress/continue-watching:
 *   get:
 *     tags: [Progress]
 *     summary: Continue-watching rail, newest first, completed excluded
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: header, name: X-Profile-Id, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: limit, schema: { type: integer, default: 20, maximum: 50 } }
 *     responses:
 *       200: { description: Continue-watching items with resume positions }
 */
router.get('/continue-watching', controller.continueWatching);

/**
 * @openapi
 * /progress/titles/{titleId}:
 *   get:
 *     tags: [Progress]
 *     summary: Resume position for a single title/episode
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: header, name: X-Profile-Id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: titleId, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: episodeId, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Progress row (or null) with computed resumePosition }
 */
router.get('/titles/:titleId', controller.getByTitle);

export default router;
