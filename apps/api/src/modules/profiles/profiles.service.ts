import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { getPrisma } from '../../lib/prisma.js';
import type { ProfileCreateInput, ProfileUpdateInput } from './profiles.schemas.js';

/**
 * Profiles service — per-user viewing profiles (Netflix-style).
 *
 * Kids profiles (isKids=true) additionally force maturity ≤ 12 so the kids
 * filter middleware never lets explicit content through even if a bad client
 * sends a high maturity value.
 */

const MAX_PROFILES = 5;
const KIDS_MATURITY_CAP = 12;

export interface ProfileDto {
  id: string;
  name: string;
  avatarUrl: string | null;
  isKids: boolean;
  language: string;
  maturity: number;
  autoplayNext: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(p: {
  id: string;
  name: string;
  avatarUrl: string | null;
  isKids: boolean;
  language: string;
  maturity: number;
  autoplayNext: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ProfileDto {
  return {
    id: p.id,
    name: p.name,
    avatarUrl: p.avatarUrl,
    isKids: p.isKids,
    language: p.language,
    maturity: p.maturity,
    autoplayNext: p.autoplayNext,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function listProfiles(userId: string): Promise<ProfileDto[]> {
  const prisma = getPrisma();
  const rows = await prisma.profile.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toDto);
}

export async function getProfile(userId: string, profileId: string): Promise<ProfileDto> {
  const prisma = getPrisma();
  const row = await prisma.profile.findFirst({ where: { id: profileId, userId } });
  if (!row) throw new NotFoundError('Profile not found');
  return toDto(row);
}

export async function createProfile(userId: string, input: ProfileCreateInput): Promise<ProfileDto> {
  const prisma = getPrisma();
  const count = await prisma.profile.count({ where: { userId } });
  if (count >= MAX_PROFILES) {
    throw new ForbiddenError(`Profile limit reached (${MAX_PROFILES})`);
  }
  const maturity = input.isKids
    ? Math.min(input.maturity, KIDS_MATURITY_CAP)
    : input.maturity;
  try {
    const row = await prisma.profile.create({
      data: {
        userId,
        name: input.name,
        avatarUrl: input.avatarUrl,
        isKids: input.isKids,
        language: input.language,
        maturity,
        autoplayNext: input.autoplayNext,
      },
    });
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError('A profile with this name already exists');
    }
    throw err;
  }
}

export async function updateProfile(
  userId: string,
  profileId: string,
  input: ProfileUpdateInput,
): Promise<ProfileDto> {
  const prisma = getPrisma();
  const existing = await prisma.profile.findFirst({ where: { id: profileId, userId } });
  if (!existing) throw new NotFoundError('Profile not found');
  const isKids = input.isKids ?? existing.isKids;
  const maturity = isKids
    ? Math.min(input.maturity ?? existing.maturity, KIDS_MATURITY_CAP)
    : input.maturity ?? existing.maturity;
  try {
    const row = await prisma.profile.update({
      where: { id: profileId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl ?? null } : {}),
        ...(input.isKids !== undefined ? { isKids: input.isKids } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        maturity,
        ...(input.autoplayNext !== undefined ? { autoplayNext: input.autoplayNext } : {}),
      },
    });
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError('A profile with this name already exists');
    }
    throw err;
  }
}

export async function deleteProfile(userId: string, profileId: string): Promise<void> {
  const prisma = getPrisma();
  const existing = await prisma.profile.findFirst({ where: { id: profileId, userId } });
  if (!existing) throw new NotFoundError('Profile not found');
  const count = await prisma.profile.count({ where: { userId } });
  if (count <= 1) {
    throw new ForbiddenError('Cannot delete the last remaining profile');
  }
  await prisma.profile.delete({ where: { id: profileId } });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

/** Used by authenticate.attachProfile — returns the context or null. */
export async function getProfileContext(userId: string, profileId: string) {
  const prisma = getPrisma();
  const row = await prisma.profile.findFirst({
    where: { id: profileId, userId },
    select: { id: true, name: true, isKids: true, maturity: true, language: true },
  });
  return row;
}
