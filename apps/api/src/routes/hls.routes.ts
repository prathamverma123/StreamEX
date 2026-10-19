import { Router } from 'express';
import { streamHls } from '../modules/playback/playback.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

/**
 * Token-verified HLS proxy (local-storage dev flow).
 *
 * Path shape: /hls/:token/master.m3u8 | /hls/:token/renditions/720p/index.m3u8
 * The SAME token authorizes the manifest and every segment below it, because
 * the player keeps the token in the URL path for the whole session.
 *
 * In production nginx serves `assets/` straight from disk / S3 origin with the\n * same path layout, so switching to nginx requires no player change.
 */
const router = Router();

router.get('/:token/*', asyncHandler(streamHls));

export default router;
