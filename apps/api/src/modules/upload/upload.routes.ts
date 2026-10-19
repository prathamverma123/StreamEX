import { Router } from 'express';
import express from 'express';
import * as controller from './upload.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAdmin } from '../../middleware/requireAdmin.js';
import { loadEnv } from '../../config/env.js';

/**
 * Resumable upload routes.
 *
 * Chunk bodies are raw octet-stream, capped at the configured chunk size.
 */

const router = Router();
const env = loadEnv();

router.use(authenticate(), requireAdmin());

/**
 * @openapi
 * /upload/init:
 *   post:
 *     tags: [Uploads]
 *     summary: Open a resumable upload session
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [assetId, filename, totalBytes]
 *             properties:
 *               assetId: { type: string, format: uuid }
 *               filename: { type: string }
 *               totalBytes: { type: integer }
 *               chunkSize: { type: integer, default: 8388608 }
 *     responses:
 *       201: { description: Session opened; PATCH chunks at the returned offset }
 *       404: { description: Asset not found }
 *       413: { description: File exceeds UPLOAD_MAX_BYTES }
 */
router.post('/init', controller.init);

/**
 * @openapi
 * /upload/{uploadId}?offset=:
 *   patch:
 *     tags: [Uploads]
 *     summary: Append one chunk at a verified offset
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uploadId, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: offset, required: true, schema: { type: integer } }
 *       - { in: header, name: X-Chunk-Etag, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/octet-stream:
 *           schema: { type: string, format: binary }
 *     responses:
 *       200: { description: Chunk stored; nextOffset returned }
 *       400: { description: Offset mismatch or closed session }
 */
router.patch(
  '/:id',
  express.raw({
    type: 'application/octet-stream',
    limit: env.UPLOAD_CHUNK_SIZE * 2,
  }),
  controller.appendChunk,
);

/**
 * @openapi
 * /upload/{uploadId}/complete:
 *   post:
 *     tags: [Uploads]
 *     summary: Finalize the upload and enqueue the transcode job
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uploadId, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               etag: { type: string }
 *     responses:
 *       200: { description: Asset moved to PROCESSING, transcode queued }
 *       400: { description: Byte count mismatch }
 */
router.post('/:id/complete', controller.complete);

/**
 * @openapi
 * /upload/{uploadId}:
 *   get:
 *     tags: [Uploads]
 *     summary: Resume information for a broken upload
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: uploadId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Session status + nextOffset }
 *       404: { description: Session not found }
 */
router.get('/:id', controller.status);

export default router;
