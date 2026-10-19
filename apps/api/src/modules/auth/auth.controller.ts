import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from '../../config/env.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import * as authService from './auth.service.js';
import {
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from './auth.schemas.js';

/**
 * Auth controller — thin HTTP layer over auth.service.
 *
 * Refresh tokens are returned in the body (for the React client to store) and
 * ALSO set as a httpOnly cookie for clients that prefer cookie flows.
 */

const REFRESH_COOKIE = 'streamex_refresh';

function parseBody<T>(schema: { parse: (input: unknown) => T }, req: Request): T {
  return schema.parse(req.body);
}

export function readRefreshCookie(req: Request): string | undefined {
  const raw = req.cookies?.[REFRESH_COOKIE];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export const register = asyncHandler(async (req: Request, res: Response) => {
  const input = parseBody(registerSchema, req);
  const result = await authService.register(input);
  res.status(201).json(result);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const input = parseBody(loginSchema, req);
  const result = await authService.login(input, {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });
  res.status(200).json(result);
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const body = refreshSchema.parse(req.body ?? {});
  const token = body.refreshToken || readRefreshCookie(req);
  if (!token) {
    throw new UnauthorizedError('Refresh token is required');
  }
  const result = await authService.refresh(token, {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });
  res.status(200).json(result);
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const token = readRefreshCookie(req) ?? (req.body as { refreshToken?: string } | undefined)?.refreshToken;
  if (!token) {
    res.status(204).send();
    return;
  }
  await authService.logout(token);
  res.status(204).send();
});

export const logoutAll = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  await authService.logoutAll(req.user.id);
  res.status(204).send();
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  res.status(200).json({ user: req.user });
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const input = parseBody(forgotPasswordSchema, req);
  const result = await authService.forgotPassword(input);
  // Never reveal whether the email exists. In development the reset URL is
  // echoed back because there is no real mail server (MAIL_TRANSPORT=console).
  res.status(202).json({
    message: 'If the account exists, a reset link has been sent',
    ...(loadEnv().NODE_ENV === 'development' && result.resetUrl
      ? { resetUrl: result.resetUrl }
      : {}),
  });
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const input = parseBody(resetPasswordSchema, req);
  await authService.resetPassword(input);
  res.status(200).json({ message: 'Password updated' });
});
