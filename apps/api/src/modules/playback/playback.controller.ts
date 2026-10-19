import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { manifestQuerySchema } from './playback.schemas.js';
import * as service from './playback.service.js';

/**
 * Playback controller.
 *
 * POST /playback/:assetId/manifest — mint the signed HLS playback bundle.
 * GET  /hls/:token/*              — token-verified media proxy (local backend)
 *                                    or 302 redirect to presigned S3 URL.
 */

export const createManifest = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  if (!req.profile) {
    // Playback always needs a profile context for kids filtering + progress sync.
    throw new UnauthorizedError('X-Profile-Id header is required for playback');
  }
  const query = manifestQuerySchema.parse(req.query);
  const manifest = await service.createManifest(String(req.params.assetId), req.profile, query);
  res.status(200).json(manifest);
});

/**
 * HLS proxy. Only used with the local storage backend (nginx serves files
 * directly in production; this route exists for dev without nginx).
 */
export const streamHls = asyncHandler(async (req: Request, res: Response) => {
  const token = String(req.params.token);
  const path = String(req.params[0] ?? '');
  const manifest = await service.resolveToken(token);
  if (!manifest) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid or expired token' } });
    return;
  }
  const key = service.storageKeyFor(manifest.assetId, path);
  const result = await service.streamObject(key);
  if (!result) {
    res.status(404).send('Not found');
    return;
  }
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Cache-Control', 'public, max-age=60');
  if (result.length !== undefined) res.setHeader('Content-Length', String(result.length));
  result.stream.pipe(res);
});

export const listRenditions = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const renditions = await service.listRenditions(String(req.params.assetId));
  res.json({ renditions });
});
