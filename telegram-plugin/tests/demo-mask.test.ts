/**
 * Tests for demo-mask.ts — the PII masking behind the `demo` suffix on
 * Telegram status commands. Pure functions with a per-process stable map;
 * the determinism + distinctness + shape contracts are what callers rely on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  maskEmail,
  maskUsername,
  maskVaultKey,
  __resetDemoMaskCachesForTest,
} from '../demo-mask.js';

beforeEach(() => {
  __resetDemoMaskCachesForTest();
});

describe('maskEmail', () => {
  it('is deterministic — same input maps to the same output', () => {
    const first = maskEmail('alice@realcorp.com');
    const second = maskEmail('alice@realcorp.com');
    expect(second).toBe(first);
  });

  it('maps distinct inputs to distinct outputs', () => {
    const a = maskEmail('alice@realcorp.com');
    const b = maskEmail('bob@realcorp.com');
    const c = maskEmail('carol@realcorp.com');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('produces an email-shaped fake on the reserved example.com domain', () => {
    const masked = maskEmail('alice@realcorp.com');
    expect(masked).toMatch(/^[^@\s]+@example\.com$/);
    expect(masked).not.toContain('realcorp');
  });

  it('never echoes the real address', () => {
    const real = 'someone.private@acme.io';
    expect(maskEmail(real)).not.toBe(real);
    expect(maskEmail(real)).not.toContain('acme');
  });

  it('assigns the fixed pool in order from a clean cache', () => {
    expect(maskEmail('one@x.com')).toBe('ada@example.com');
    expect(maskEmail('two@x.com')).toBe('grace@example.com');
    expect(maskEmail('three@x.com')).toBe('linus@example.com');
  });

  it('falls back to a stable distinct form past the pool', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 15; i++) seen.add(maskEmail(`user${i}@x.com`));
    // 15 distinct inputs → 15 distinct masked emails (pool of 10 + overflow).
    expect(seen.size).toBe(15);
    // The overflow form is still example.com-shaped.
    for (const m of seen) expect(m).toMatch(/^[^@\s]+@example\.com$/);
  });

  it('masks a non-email label to a stable fake email too', () => {
    const a = maskEmail('work-account');
    const b = maskEmail('work-account');
    expect(a).toBe(b);
    expect(a).toMatch(/^[^@\s]+@example\.com$/);
  });
});

describe('maskUsername', () => {
  it('is deterministic for a @handle input', () => {
    expect(maskUsername('@ken_real')).toBe(maskUsername('@ken_real'));
  });

  it('is deterministic for a numeric id input', () => {
    expect(maskUsername('8248703757')).toBe(maskUsername('8248703757'));
  });

  it('maps the first distinct input to @demo_user', () => {
    expect(maskUsername('@ken_real')).toBe('@demo_user');
  });

  it('maps a second distinct input to @demo_user2', () => {
    maskUsername('@ken_real');
    expect(maskUsername('8248703757')).toBe('@demo_user2');
  });

  it('always yields a @handle shape and never echoes the real id', () => {
    const masked = maskUsername('@ken_real');
    expect(masked).toMatch(/^@demo_user\d*$/);
    expect(masked).not.toContain('ken_real');
  });

  it('normalises a numeric id to a @handle (not a raw number)', () => {
    expect(maskUsername('8248703757')).toMatch(/^@demo_user\d*$/);
  });
});

describe('maskVaultKey', () => {
  it('is deterministic — same key maps to the same masked name', () => {
    expect(maskVaultKey('coolify/api-token')).toBe(maskVaultKey('coolify/api-token'));
  });

  it('maps distinct keys to distinct masked names', () => {
    const a = maskVaultKey('coolify/api-token');
    const b = maskVaultKey('github/token');
    expect(a).not.toBe(b);
  });

  it('keeps the namespace/key shape and hides the real service', () => {
    const masked = maskVaultKey('coolify/api-token');
    expect(masked).toMatch(/^demo\/secret-\d+$/);
    expect(masked).not.toContain('coolify');
  });

  it('assigns demo/secret-N in order from a clean cache', () => {
    expect(maskVaultKey('coolify/api-token')).toBe('demo/secret-1');
    expect(maskVaultKey('github/token')).toBe('demo/secret-2');
    expect(maskVaultKey('fatsecret/client_id')).toBe('demo/secret-3');
  });
});

describe('cross-category isolation', () => {
  it('keeps each category in its own namespace', () => {
    // Identical raw text in different categories must not collide caches.
    expect(maskEmail('x')).toMatch(/@example\.com$/);
    expect(maskUsername('x')).toMatch(/^@demo_user/);
    expect(maskVaultKey('x')).toMatch(/^demo\/secret-/);
  });
});
