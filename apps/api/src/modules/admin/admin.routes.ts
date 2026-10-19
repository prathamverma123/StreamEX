import { Router } from 'express';
import * as controller from './admin.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAdmin } from '../../middleware/requireAdmin.js';

/**
 * Admin routes — every route requires the ADMIN role.
 */

const router = Router();
router.use(authenticate(), requireAdmin());

/**
 * @openapi
 * /admin/titles/bulk:
 *   post:
 *     tags: [Admin]
 *     summary: Bulk title ingestion (JSON rows, per-row validation)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [titles]
 *             properties:
 *               titles:
 *                 type: array
 *                 maxItems: 500
 *                 items: { $ref: '#/components/schemas/BulkTitleRow' }
 *     responses:
 *       200:
 *         description: Ingestion report (per-row errors included)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ingestionId: { type: string }
 *                 total: { type: integer }
 *                 created: { type: integer }
 *                 updated: { type: integer }
 *                 failed: { type: integer }
 *                 errors: { type: array, items: { type: object } }
 */
router.post('/titles/bulk', controller.bulkUploadTitles);

/**
 * @openapi
 * /admin/assets:
 *   post:
 *     tags: [Admin]
 *     summary: Create a video asset and open a resumable upload
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [titleId, filename, totalBytes]
 *             properties:
 *               titleId: { type: string, format: uuid }
 *               episodeId: { type: string, format: uuid }
 *               filename: { type: string }
 *               totalBytes: { type: integer }
 *               sourceMime: { type: string }
 *     responses:
 *       201: { description: Asset created (status UPLOADING) }
 *       404: { description: Title or episode not found }
 */
router.post('/assets', controller.createAsset);

/**
 * @openapi
 * /admin/moderation:
 *   get:
 *     tags: [Admin]
 *     summary: Moderation queue
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [PENDING, APPROVED, REJECTED], default: PENDING } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, default: 25 } }
 *     responses:
 *       200: { description: Moderation page }
 */
router.get('/moderation', controller.listModeration);

/**
 * @openapi
 * /admin/moderation/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Approve or reject a moderation item
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action: { type: string, enum: [approve, reject] }
 *               notes: { type: string }
 *     responses:
 *       200: { description: Item reviewed }
 *       409: { description: Already reviewed }
 */
router.patch('/moderation/:id', controller.reviewModeration);

/**
 * @openapi
 * /admin/assets/{assetId}/requeue:
 *   post:
 *     tags: [Admin]
 *     summary: Requeue a failed transcode (runbook: failed-transcode recovery)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: assetId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Asset requeued }
 *       409: { description: Asset is not in a requeueable state }
 */
router.post('/assets/:assetId/requeue', controller.requeueAsset);

export default router;
