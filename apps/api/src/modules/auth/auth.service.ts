import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '../../lib/errors.js';
import { hashToken, refreshTokenTtlSeconds, signAccessToken, signRefreshToken, verifyRefreshToken, generateOpaqueToken } from '../../lib/jwt.js';
import { passwordResetEmail, sendMail } from '../../lib/mailer.js';
import { getPrisma } from '../../lib/prisma.js';
import { loadEnv } from '../../config/env.js';
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from './auth.schemas.js';

/**
 * Auth service — registration, login, refresh-token rotation with reuse
 * detection, logout, password reset.
 *
 * Refresh-token model:
 *   Each login creates a Session row with a `familyId`. Every refresh issues a
 *   NEW refresh token (stored as SHA-256 hash) and REVOKES the old session row
 *   after marking the new row as the family's current token. If a token that
 *   was already rotated is presented again, the whole FAMILY is revoked —
 *   classic stolen-token detection.
 */

const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_TTL_MINUTES = 30;

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: string };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const prisma = getPrisma();
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: { email: input.email, passwordHash },
  });
  // First profile is created automatically.
  await prisma.profile.create({
    data: { userId: user.id, name: input.name ?? 'Profile 1' },
  });
  const { accessToken, refreshToken } = await issueTokens(
    user.id,
    user.email,
    user.role,
  );
  return { accessToken, refreshToken, user: { id: user.id, email: user.email, role: user.role } };
}

async function issueTokens(
  userId: string,
  email: string,
  role: string,
  ctx?: { userAgent?: string; ip?: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const prisma = getPrisma();
  const familyId = randomUUID();
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: 'pending',
      familyId,
      userAgent: ctx?.userAgent,
      ip: ctx?.ip,
      expiresAt: new Date(Date.now() + refreshTokenTtlSeconds() * 1000),
    },
  });
  const refreshToken = signRefreshToken({ sub: userId, sid: session.id, fam: familyId });
  await prisma.session.update({
    where: { id: session.id },
    data: { tokenHash: hashToken(refreshToken) },
  });
  const accessToken = signAccessToken({ sub: userId, email, role: role as 'USER' | 'ADMIN' });
  return { accessToken, refreshToken };
}

export async function login(input: LoginInput, ctx?: { userAgent?: string; ip?: string }): Promise<AuthResult> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) {
    // Constant-ish time: still run a bcrypt compare to avoid user enumeration.
    await bcrypt.compare(input.password, '$2a$12$usesirconlyforbtiminghere.9');
    throw new UnauthorizedError('Invalid email or password');
  }
  if (user.isSuspended) throw new ForbiddenError('Account suspended');
  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) throw new UnauthorizedError('Invalid email or password');
  const { accessToken, refreshToken } = await issueTokens(user.id, user.email, user.role, ctx);
  return { accessToken, refreshToken, user: { id: user.id, email: user.email, role: user.role } };
}

/** Rotate a refresh token. Reuse of an already-rotated token kills the family. */
export async function refresh(
  refreshToken: string,
  ctx?: { userAgent?: string; ip?: string },
): Promise<AuthResult> {
  const prisma = getPrisma();
  const payload = verifyRefreshToken(refreshToken);
  const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
  if (!session) {
    // Token was already rotated → replay attack. Kill the whole family.
    await revokeFamily(payload.fam, 'token-reuse');
    throw new UnauthorizedError('Refresh token is no longer valid');
  }
  if (session.revokedAt) {
    await revokeFamily(payload.fam, 'token-reuse');
    throw new UnauthorizedError('Refresh token is no longer valid');
  }
  // Defense in depth: the JWT carries its own exp, but the session row is
  // the source of truth for revocation on password reset / logout-all, and
  // its expiry can trail the JWT's if TTLs drift. Never trust a stale row.
  if (session.expiresAt.getTime() < Date.now()) {
    await revokeFamily(payload.fam, 'expired');
    throw new UnauthorizedError('Refresh token is no longer valid');
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw new UnauthorizedError('Session user no longer exists');
  if (user.isSuspended) {
    await revokeFamily(payload.fam, 'user-suspended');
    throw new ForbiddenError('Account suspended');
  }
  const nextRefreshToken = signRefreshToken({
    sub: user.id,
    sid: session.id,
    fam: payload.fam,
  });
  await prisma.session.update({
    where: { id: session.id },
    data: {
      tokenHash: hashToken(nextRefreshToken),
      lastUsedAt: new Date(),
      ...(ctx?.userAgent ? { userAgent: ctx.userAgent } : {}),
      ...(ctx?.ip ? { ip: ctx.ip } : {}),
    },
  });
  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role as 'USER' | 'ADMIN',
  });
  return {
    accessToken,
    refreshToken: nextRefreshToken,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

async function revokeFamily(familyId: string, reason: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export async function logout(refreshToken: string): Promise<void> {
  const prisma = getPrisma();
  const hash = hashToken(refreshToken);
  const session = await prisma.session.findUnique({ where: { tokenHash: hash } });
  if (!session) return; // idempotent
  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date(), revokedReason: 'logout' },
  });
}

export async function logoutAll(userId: string): Promise<void> {
  await revokeFamilyAll(userId);
}

async function revokeFamilyAll(userId: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'logout-all' },
  });
}

export async function forgotPassword(input: ForgotPasswordInput): Promise<{ sent: boolean; resetUrl?: string }> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  // Always return success to avoid account enumeration.
  if (!user) return { sent: false };
  const { raw, hash } = generateOpaqueToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
    },
  });
  const env = loadEnv();
  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${raw}`;
  const body = passwordResetEmail(resetUrl, RESET_TOKEN_TTL_MINUTES);
  await sendMail({ to: user.email, subject: 'Reset your StreamEX password', ...body });
  return { sent: true, resetUrl };
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const prisma = getPrisma();
  const hash = hashToken(input.token);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hash } });
  if (!record) throw new ValidationError('Invalid or expired reset token');
  if (record.usedAt) throw new ValidationError('Reset token already used');
  if (record.expiresAt.getTime() < Date.now()) {
    throw new ValidationError('Invalid or expired reset token');
  }
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    }),
    prisma.session.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'password-reset' },
    }),
  ]);
}
