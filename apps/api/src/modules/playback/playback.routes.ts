import { Router } from 'express';
import * as controller from './playback.controller.js';
import { authenticate, attachProfile } from '../../middleware/authenticate.js';
import { getProfileContext } from '../profiles/profiles.service.js';
import { globalLimiter } from '../../middleware/rateLimit.js';

const router = Router();

/**
 * @openapi
 * /playback/{assetId}/manifest:
 *   post:
 *     tags: [Playback]
 *     summary: Get a signed HLS playback bundle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: header, name: X-Profile-Id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: assetId, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: bandwidth, schema: { type: integer, description: Client bandwidth hint bps } }
 *       - { in: query, name: deviceWidth, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: Signed playback bundle
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 assetId: { type: string }
 *                 playbackUrl: { type: string }
 *                 token: { type: string }
 *                 expiresAt: { type: string, format: date-time }
 *                 renditions: { type: array, items: { $ref: '#/components/schemas/Rendition' } }
 *                 startRendition: { type: string, nullable: true }
 *                 thumbnailSpriteUrl: { type: string, nullable: true }
 *                 thumbnailVttUrl: { type: string, nullable: true }
 *                 subtitles: { type: array, items: { $ref: '#/components/schemas/SubtitleTrack' } }
 *       403: { description: Token invalid/expired or title not allowed for profile }
 *       404: { description: Asset not found or not READY }
 */
router.post('/:assetId/manifest', authenticate(), attachProfile(getProfileContext), controller.createManifest);

/**
 * @openapi
 * /playback/{assetId}/renditions:
 *   get:
 *     tags: [Playback]
 *     summary: List renditions for an asset
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: assetId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Rendition list }
 *       404: { description: Asset not found }
 */
router.get('/:assetId/renditions', authenticate(), attachProfile(getProfileContext), controller.listRenditions);

export default router;
