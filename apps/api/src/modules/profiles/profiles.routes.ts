import { Router } from 'express';
import * as controller from './profiles.controller.js';
import { authenticate, attachProfile } from '../../middleware/authenticate.js';
import { getProfileContext } from './profiles.service.js';

/**
 * Profile routes — all authenticated.
 * X-Profile-Id header selects the active profile for catalog/playback routes.
 */

const router = Router();
router.use(authenticate());
router.use(attachProfile(getProfileContext));

/**
 * @openapi
 * /profiles:
 *   get:
 *     tags: [Profiles]
 *     summary: List the user's profiles
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Profiles list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 profiles:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Profile' }
 */
router.get('/', controller.listProfiles);

/**
 * @openapi
 * /profiles:
 *   post:
 *     tags: [Profiles]
 *     summary: Create a profile (max 5 per user)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ProfileInput' }
 *     responses:
 *       201: { description: Profile created }
 *       403: { description: Profile limit reached }
 *       409: { description: Duplicate profile name }
 */
router.post('/', controller.createProfile);

/**
 * @openapi
 * /profiles/{id}:
 *   get:
 *     tags: [Profiles]
 *     summary: Fetch one profile
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Profile }
 *       404: { description: Not found }
 */
router.get('/:id', controller.getProfile);

/**
 * @openapi
 * /profiles/{id}:
 *   patch:
 *     tags: [Profiles]
 *     summary: Update a profile
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ProfileInput' }
 *     responses:
 *       200: { description: Profile updated }
 *       404: { description: Not found }
 */
router.patch('/:id', controller.updateProfile);

/**
 * @openapi
 * /profiles/{id}:
 *   delete:
 *     tags: [Profiles]
 *     summary: Delete a profile (never the last one)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       204: { description: Profile deleted }
 *       403: { description: Cannot delete the last profile }
 */
router.delete('/:id', controller.deleteProfile);

export default router;
