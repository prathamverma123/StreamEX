import { Router } from 'express';
import * as controller from './auth.controller.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { authenticate } from '../../middleware/authenticate.js';

/**
 * Auth routes.
 *
 * All are rate-limited with the strict limiter. Refresh tokens are also set as
 * httpOnly cookies; the body copy is kept for API clients.
 */

const router = Router();

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Create an account
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, example: viewer@streamex.dev }
 *               password: { type: string, example: Sup3rSecret!pass }
 *               name: { type: string, example: Alex }
 *     responses:
 *       201: { description: Account created, tokens returned }
 *       409: { description: Email already registered }
 *       429: { description: Rate limited }
 */
router.post('/register', authLimiter(), controller.register);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200: { description: Tokens issued }
 *       401: { description: Invalid credentials }
 */
router.post('/login', authLimiter(), controller.login);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Rotate refresh token
 *     description: >-
 *       Presents the current refresh token and receives a brand new pair.
 *       Replaying an already-rotated token revokes the entire token family
 *       (stolen-token detection).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200: { description: New token pair }
 *       401: { description: Token invalid, expired or replayed }
 */
router.post('/refresh', authLimiter(), controller.refresh);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Revoke the presented refresh token
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       204: { description: Session revoked (idempotent) }
 */
router.post('/logout', authLimiter(), controller.logout);

/**
 * @openapi
 * /auth/logout-all:
 *   post:
 *     tags: [Auth]
 *     summary: Revoke every active session for the signed-in user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: All sessions revoked }
 */
router.post('/logout-all', authenticate(), controller.logoutAll);

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Current authenticated user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: User claims }
 *       401: { description: Not authenticated }
 */
router.get('/me', authenticate(), controller.me);

/**
 * @openapi
 * /auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request a password reset email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string }
 *     responses:
 *       202: { description: Reset link queued (response identical whether or not the account exists) }
 */
router.post('/forgot-password', authLimiter(), controller.forgotPassword);

/**
 * @openapi
 * /auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Reset password with an emailed token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token: { type: string }
 *               password: { type: string }
 *     responses:
 *       200: { description: Password updated, all sessions revoked }
 *       400: { description: Invalid / expired / used token }
 */
router.post('/reset-password', authLimiter(), controller.resetPassword);

export default router;
