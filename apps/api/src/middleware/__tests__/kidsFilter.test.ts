import {
  allowedRatings,
  kidsScope,
  isPlayableForProfile,
} from '../kidsFilter.js';

describe('allowedRatings', () => {
  it('returns only kids-safe ratings for kids profiles', () => {
    expect(allowedRatings(true, 100)).toEqual(['G', 'TV-Y', 'TV-G', 'PG', 'TV-Y7']);
  });

  it('is kids-safe regardless of a maliciously high maturity value', () => {
    expect(allowedRatings(true, 100)).not.toContain('TV-MA');
    expect(allowedRatings(true, 100)).not.toContain('R');
    expect(allowedRatings(true, 100)).not.toContain('NC-17');
  });

  it('filters by maturity weight for adult profiles', () => {
    expect(allowedRatings(false, 100)).toContain('NC-17');
    expect(allowedRatings(false, 90)).toContain('TV-MA');
    expect(allowedRatings(false, 90)).not.toContain('NC-17');
  });

  it('maturity 40 caps at PG-13', () => {
    const ratings = allowedRatings(false, 40);
    expect(ratings).toContain('PG-13');
    expect(ratings).not.toContain('TV-14');
    expect(ratings).not.toContain('R');
  });

  it('maturity 0 sees only all-ages content', () => {
    expect(allowedRatings(false, 0)).toEqual(['G', 'TV-Y', 'TV-G']);
  });
});

describe('kidsScope', () => {
  it('restricts to kids ratings for kids profiles', () => {
    const scope = kidsScope(true, 10);
    expect(scope.rating).toMatchObject({ in: ['G', 'TV-Y', 'TV-G', 'PG', 'TV-Y7'] });
  });

  it('adds moderation + publication guards for kids', () => {
    const scope = kidsScope(true, 10);
    expect(scope.moderationStatus).toBe('APPROVED');
    expect(scope.status).toBe('PUBLISHED');
  });

  it('does not add moderation guards for adult profiles', () => {
    const scope = kidsScope(false, 100);
    expect(scope.moderationStatus).toBeUndefined();
    expect(scope.status).toBeUndefined();
    expect(scope.rating).toMatchObject({ in: expect.arrayContaining(['NC-17']) });
  });
});

describe('isPlayableForProfile', () => {
  it('allows kids content to kids profiles', () => {
    expect(
      isPlayableForProfile({ rating: 'G', moderationStatus: 'APPROVED' }, true, 10),
    ).toBe(true);
    expect(
      isPlayableForProfile({ rating: 'TV-Y7', moderationStatus: 'APPROVED' }, true, 10),
    ).toBe(true);
  });

  it('blocks mature content from kids profiles', () => {
    expect(isPlayableForProfile({ rating: 'PG-13', moderationStatus: 'APPROVED' }, true, 100)).toBe(false);
    expect(isPlayableForProfile({ rating: 'TV-MA', moderationStatus: 'APPROVED' }, true, 100)).toBe(false);
  });

  it('respects maturity for adult profiles', () => {
    expect(isPlayableForProfile({ rating: 'R' }, false, 80)).toBe(true);
    expect(isPlayableForProfile({ rating: 'R' }, false, 60)).toBe(false);
  });

  it('requires APPROVED moderation for kids', () => {
    expect(isPlayableForProfile({ rating: 'G', moderationStatus: 'PENDING' }, true, 0)).toBe(false);
    expect(isPlayableForProfile({ rating: 'G', moderationStatus: 'APPROVED' }, true, 0)).toBe(true);
    // missing moderationStatus field entirely → not playable for kids
    expect(isPlayableForProfile({ rating: 'G' }, true, 0)).toBe(false);
  });

  it('ignores moderation status for adult profiles', () => {
    expect(isPlayableForProfile({ rating: 'G', moderationStatus: 'PENDING' }, false, 100)).toBe(true);
  });
});
