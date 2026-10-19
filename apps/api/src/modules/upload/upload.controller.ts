import type { Request, Response } from 'express';
import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as service from './upload.service.js';
import { uploadCompleteSchema, uploadInitSchema } from '../admin/admin.schemas.js';

/**
 * Upload controller.
 *
 * The PATCH chunk endpoint reads a raw binary body (`Content-Type:
 * application/octet-stream`) — express.raw is configured on the route.
 */

export const init = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const input = uploadInitSchema.parse(req.body);
  const result = await service.initUpload(req.user.id, input);
  res.status(201).json(result);
});

export const appendChunk = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const offset = Number(req.query.offset ?? 0);
  const chunk = req.body as Buffer;
  const etag = req.headers['x-chunk-etag'];
  const result = await service.appendChunk(
    req.user.id,
    String(req.params.id),
    offset,
    Buffer.isBuffer(chunk) ? chunk : Buffer.alloc(0),
    typeof etag === 'string' ? etag : undefined,
  );
  res.json(result);
});

export const complete = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const input = uploadCompleteSchema.parse(req.body ?? {});
  const result = await service.completeUpload(req.user.id, String(req.params.id), input);
  res.json(result);
});

export const status = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const result = await service.uploadStatus(req.user.id, String(req.params.id));
  res.json(result);
});
