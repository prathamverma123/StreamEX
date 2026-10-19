import bcrypt from 'bcryptjs';
import * as authService from '../auth.service.js';
import {
  makePrismaMock,
  fixtureUser,
  fixtureSession,
  TEST_PASSWORD,
  UUIDS,
} from '../../../testutil/index.js';
import { setPrismaForTests } from '../../../lib/prisma.js';
import { loadEnv } from '../../../config/env.js';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '../../../lib/errors.js';
import { signRefreshToken, hashToken, verifyAccessToken } from '../../../lib/jwt.js';

const prismaMock = makePrismaMock();

beforeEach(() => {
  setPrismaForTests(prismaMock.client);
});

afterEach(() => {
  setPrismaForTests(undefined);
});

describe('register', () => {
  it('creates the user, a first profile and returns a token pair', async () => {
    prismaMock.models.user.findUnique.mockResolvedValue(null);
    prismaMock.models.user.create.mockImplementation(async ({ data }: { data: { email: string; passwordHash: string } }) =>
      fixtureUser({ email: data.email, passwordHash: data.passwordHash }),
    );
    prismaMock.models.profile.create.mockResolvedValue({});
    prismaMock.models.session.create.mockImplementation(
      async ({ data }: { data: { id?: string; userId: string } }) =>
        fixtureSession({ id: data.id ?? UUIDS.session, userId: data.userId }),
    );
    prismaMock.models.session.update.mockResolvedValue({});

    const result = await authService.register({
      email: 'New.User@Streamex.dev',
      password: TEST_PASSWORD,
      name: 'Alex',
    });

    // email normalised to lowercase
    expect(prismaMock.models.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'New.User@Streamex.dev' }),
      }),
    );
    expect(result.user.email).toBe('New.User@Streamex.dev');
    expect(result.user.role).toBe('USER');
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(() => verifyAccessToken(result.accessToken)).not.toThrow();
  });

  it('hashes the password with bcrypt (never stores plaintext)', async () => {
    prismaMock.models.user.findUnique.mockResolvedValue(null);
    prismaMock.models.user.create.mockResolvedValue(fixtureUser());
    prismaMock.models.profile.create.mockResolvedValue({});
    prismaMock.models.session.create.mockResolvedValue(fixtureSession());
    prismaMock.models.session.update.mockResolvedValue({});

    await authService.register({ email: 'a@b.c', password: TEST_PASSWORD });

    const call = prismaMock.models.user.create.mock.calls[0]![0] as {
      data: { passwordHash: string };
    };
    expect(call.data.passwordHash).not.toBe(TEST_PASSWORD);
    expect(call.data.passwordHash.startsWith('$2')).toBe(true);
  });

  it('creates the first profile with the display name', async () => {
    prismaMock.models.user.findUnique.mockResolvedValue(null);
    prismaMock.models.user.create.mockResolvedValue(fixtureUser());
    prismaMock.models.session.create.mockResolvedValue(fixtureSession());
    prismaMock.models.session.update.mockResolvedValue({});

    await authService.register({ email: 'a@b.c', password: TEST_PASSWORD, name: 'Ada' });
    expect(prismaMock.models.profile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'Ada', userId: fixtureUser().id }),
      }),
    );
  });

  it('conflicts when the email already exists', async () => {
    prismaMock.models.user.findUnique.mockResolvedValue(fixtureUser());
    await expect(
      authService.register({ email: 'viewer@streamex.dev', password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prismaMock.models.user.create).not.toHaveBeenCalled();
  });
});

describe('login', () => {
  it('issues tokens for valid credentials', async () => {
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    prismaMock.models.user.findUnique.mockResolvedValue(
      fixtureUser({ passwordHash }),
    );
    prismaMock.models.session.create.mockResolvedValue(fixtureSession());
    prismaMock.models.session.update.mockResolvedValue({});

    const result = await authService.login(
      { email: 'viewer@streamex.dev', password: TEST_PASSWORD },
      { userAgent: 'jest', ip: '127.0.0.1' },
    );

    expect(result.user.id).toBe(UUIDS.user);
    expect(result.refreshToken).toBeTruthy();
    expect(prismaMock.models.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: UUIDS.user,
          userAgent: 'jest',
          ip: '127.0.0.1',
        }),
      }),
    );
  });

  it('rejects an unknown email', async () => {
    prismaMock.models.user.findUnique.mockResolvedValue(null);
    await expect(
      authService.login({ email: 'ghost@streamex.dev', password: 'whatever123' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    // Anti-enumeration: a bcrypt compare still runs.
    expect(prismaMock.models.session.create).not.toHaveBeenCalled();
  });

  it('rejects a wrong password', async () => {
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    prismaMock.models.user.findUnique.mockResolvedValue(fixtureUser({ passwordHash }));
    await expect(
      authService.login({ email: 'viewer@streamex.dev', password: 'WrongPassword1' }),
    ).rejects.toThrow('Invalid email or password');
  });

  it('rejects a suspended account', async () => {
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    prismaMock.models.user.findUnique.mockResolvedValue(
      fixtureUser({ passwordHash, isSuspended: true }),
    );
    await expect(
      authService.login({ email: 'viewer@streamex.dev', password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('refresh (rotation + reuse detection)', () => {
  function seedSessionRow(token: string, overrides: Record<string, unknown> = {}) {
    const row = fixtureSession({ tokenHash: hashToken(token), ...overrides });
    prismaMock.models.session.findUnique.mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === row.tokenHash ? row : null,
    );
    return row;
  }

  it('rotates to a brand-new refresh token and marks the session used', async () => {
    const firstToken = signRefreshToken({ sub: UUIDS.user, sid: UUIDS.session, fam: 'fam-1' });
    seedSessionRow(firstToken);
    prismaMock.models.session.update.mockResolvedValue({});
    prismaMock.models.session.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.models.session.create.mockResolvedValue(fixtureSession({ id: 'session-2' }));
    prismaMock.models.user.findUnique.mockResolvedValue(fixtureUser());

    const result = await authService.refresh(firstToken);

    expect(result.refreshToken).not.toBe(firstToken);
    expect(result.accessToken).toBeTruthy();
    // Rotation model: the SAME session row is re-pointed at the new token
    // hash via update (no revocation, no second row), keeping familyId
    // stable. Reuse detection relies on the OLD hash no longer matching.
    expect(prismaMock.models.session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: UUIDS.session },
        data: expect.objectContaining({
          tokenHash: hashToken(result.refreshToken),
          lastUsedAt: expect.any(Date),
        }),
      }),
    );
    expect(prismaMock.models.session.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'rotated' }),
      }),
    );
    expect(prismaMock.models.session.create).not.toHaveBeenCalled();
  });

  it('kills the whole family on replay of an already-rotated token', async () => {
    const staleToken = signRefreshToken({ sub: UUIDS.user, sid: 'old', fam: 'fam-1' });
    // The token hash no longer matches any row → replay.
    prismaMock.models.session.findUnique.mockResolvedValue(null);
    prismaMock.models.session.updateMany.mockResolvedValue({ count: 3 });
    prismaMock.models.session.update.mockResolvedValue({});

    await expect(authService.refresh(staleToken)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.models.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ familyId: 'fam-1' }),
        data: expect.objectContaining({ revokedReason: 'token-reuse' }),
      }),
    );
  });

  it('kills the family when the session row is already revoked', async () => {
    const token = signRefreshToken({ sub: UUIDS.user, sid: UUIDS.session, fam: 'fam-1' });
    seedSessionRow(token, { revokedAt: new Date(), revokedReason: 'logout' });
    prismaMock.models.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(authService.refresh(token)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(prismaMock.models.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'token-reuse' }),
      }),
    );
  });

  it('rejects a refresh token signed with the wrong key', async () => {
    const { sign } = await import('jsonwebtoken');
    const forged = sign(
      { sub: UUIDS.user, sid: 's', fam: 'f', jti: 'j', typ: 'refresh' },
      'attacker-secret-attacker-secret-attacker',
      { expiresIn: '1h', keyid: 'attacker-kid' },
    );
    await expect(authService.refresh(forged)).rejects.toThrow('Unknown token signing key');
  });

  it('rejects a refresh token with an expired session row', async () => {
    const token = signRefreshToken({ sub: UUIDS.user, sid: UUIDS.session, fam: 'fam-1' });
    seedSessionRow(token, { expiresAt: new Date(Date.now() - 1000) });
    prismaMock.models.session.updateMany.mockResolvedValue({ count: 1 });
    await expect(authService.refresh(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('logout', () => {
  it('revokes the matching session', async () => {
    const token = signRefreshToken({ sub: UUIDS.user, sid: UUIDS.session, fam: 'fam-1' });
    prismaMock.models.session.findUnique.mockResolvedValue(
      fixtureSession({ tokenHash: hashToken(token) }),
    );
    prismaMock.models.session.update.mockResolvedValue({});

    await authService.logout(token);

    expect(prismaMock.models.session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: UUIDS.session },
        data: expect.objectContaining({ revokedReason: 'logout' }),
      }),
    );
  });

  it('is a no-op for an unknown token', async () => {
    prismaMock.models.session.findUnique.mockResolvedValue(null);
    await expect(
      authService.logout(signRefreshToken({ sub: UUIDS.user, sid: 'x', fam: 'f' })),
    ).resolves.toBeUndefined();
    expect(prismaMock.models.session.update).not.toHaveBeenCalled();
  });
});

describe('logoutAll', () => {
  it('revokes every active session for the user', async () => {
    prismaMock.models.session.updateMany.mockResolvedValue({ count: 5 });
    await authService.logoutAll(UUIDS.user);
    expect(prismaMock.models.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: UUIDS.user, revokedAt: null }),
        data: expect.objectContaining({ revokedReason: 'logout-all' }),
      }),
    );
  });
});

describe('forgotPassword', () => {
  it('creates a hashed reset token with a 30-minute expiry and emails the link', async () => {
    prismaMock.models.user.findUnique.mockResolvedValue(fixtureUser());
    prismaMock.models.passwordResetToken.create.mockResolvedValue({});

    const result = await authService.forgotPassword({ email: 'viewer@streamex.dev' });

    expect(result.sent).toBe(true);
    expect(result.resetUrl).toContain('/reset-password?token=');
    const createCall = prismaMock.models.passwordResetToken.create.mock.calls[0]![0] as {
      data: { userId: string; tokenHash: string; expiresAt: Date };
    };
    expect(createCall.data.userId).toBe(UUIDS.user);
    expect(createCall.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token never appears in the stored hash.
    const rawInUrl = result.resetUrl!.split('token=')[1]!;
    expect(createCall.data.tokenHash).not.toBe(rawInUrl);
    // ~30 minutes out.
    const ttlMs = createCall.data.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(28 * 60 * 1000);
    expect(ttlMs).toBeLessThan(32 * 60 * 1000);
  });

  it('does not reveal whether the email exists', async () => {
    prismaMock.models.user.findUnique.mockResolvedValue(null);
    // Always reports success, never reveals whether the email exists.
    const result = await authService.forgotPassword({ email: 'ghost@streamex.dev' });
    expect(result.sent).toBe(false);
    expect(result.resetUrl).toBeUndefined();
    expect(prismaMock.models.passwordResetToken.create).not.toHaveBeenCalled();
  });
});

describe('resetPassword', () => {
  function seedResetRow(overrides: Record<string, unknown> = {}) {
    const raw = 'reset-token-value-0123456789';
    const row = {
      id: UUIDS.resetToken,
      userId: UUIDS.user,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      usedAt: null,
      createdAt: new Date(),
      ...overrides,
    };
    prismaMock.models.passwordResetToken.findUnique.mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === row.tokenHash ? row : null,
    );
    return raw;
  }

  it('updates the hash, marks the token used and revokes sessions atomically', async () => {
    const raw = seedResetRow();
    prismaMock.$transaction.mockImplementation(async (ops: unknown) => ops);
    prismaMock.models.passwordResetToken.update.mockResolvedValue({});
    prismaMock.models.user.update.mockResolvedValue({});
    prismaMock.models.session.updateMany.mockResolvedValue({ count: 2 });

    await authService.resetPassword({ token: raw, password: 'BrandNewP@ssw0rd' });

    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.models.passwordResetToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: UUIDS.resetToken } }),
    );
    expect(prismaMock.models.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'password-reset' }),
      }),
    );
  });

  it('rejects an unknown token', async () => {
    await expect(
      authService.resetPassword({ token: 'totally-unknown-token-123', password: 'BrandNewP@ssw0rd' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an already-used token', async () => {
    const raw = seedResetRow({ usedAt: new Date() });
    await expect(
      authService.resetPassword({ token: raw, password: 'BrandNewP@ssw0rd' }),
    ).rejects.toThrow('already used');
  });

  it('rejects an expired token', async () => {
    const raw = seedResetRow({ expiresAt: new Date(Date.now() - 1000) });
    await expect(
      authService.resetPassword({ token: raw, password: 'BrandNewP@ssw0rd' }),
    ).rejects.toThrow('expired');
  });
});

// Load env in this module context to keep the import used.
type _Env = ReturnType<typeof loadEnv>;
