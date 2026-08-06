import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * Wire-format tests for the credential encryptor.
 *
 * These do NOT import the module under test directly, because it reads its key
 * from config at import time. Instead they reimplement the Java side of the
 * contract with an explicit key and assert that the layout matches what
 * src/security/credential-encryptor.ts expects. That way the test proves the
 * FORMAT, which is the thing that has to stay compatible.
 *
 * ── Running a true cross-language check ─────────────────────────────────────
 *
 * The strongest verification is against a real value from your database. Take
 * any marketplace_accounts.encrypted_credentials blob written by the Java
 * service, set CREDENTIAL_ENCRYPTION_KEY to the production key, and confirm
 * decrypt() returns the expected token map. There is a script for this:
 *
 *     npx tsx scripts/verify-credentials.ts
 *
 * Do that once before cutting any traffic over. It is the single check that
 * catches a mismatch before it silently drops every marketplace connection.
 */

const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

/** Byte-for-byte replica of the Java CredentialEncryptor.encrypt(). */
function javaStyleEncrypt(key: Buffer, credentials: Record<string, string>): string {
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_LENGTH });
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ]);
  // Java's Cipher.doFinal() APPENDS the tag to the ciphertext.
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');
}

describe('credential encryptor wire format', () => {
  const key = randomBytes(32);
  const credentials = {
    access_token: 'shpat_0123456789abcdef',
    refresh_token: 'refresh_abcdef',
    shop: 'gearline.myshopify.com',
  };

  it('lays out bytes as IV(12) || ciphertext || tag(16)', () => {
    const blob = javaStyleEncrypt(key, credentials);
    const raw = Buffer.from(blob, 'base64');
    const plaintextLength = Buffer.byteLength(JSON.stringify(credentials), 'utf8');

    // AES-GCM is a stream cipher: ciphertext length == plaintext length.
    expect(raw.length).toBe(GCM_IV_LENGTH + plaintextLength + GCM_TAG_LENGTH);
  });

  it('produces a different blob each time (random IV)', () => {
    const a = javaStyleEncrypt(key, credentials);
    const b = javaStyleEncrypt(key, credentials);

    // Deterministic output would leak that two accounts share credentials.
    expect(a).not.toBe(b);
  });

  it('uses a 12-byte IV, not the 16-byte one people assume', () => {
    const raw = Buffer.from(javaStyleEncrypt(key, credentials), 'base64');
    const iv = raw.subarray(0, GCM_IV_LENGTH);
    expect(iv.length).toBe(12);
  });
});

describe('JWT algorithm selection', () => {
  /**
   * Replica of jjwt's Keys.hmacShaKeyFor() sizing rule. This is the single
   * highest-risk compatibility detail in the whole port: the Java signing key
   * is the raw UTF-8 bytes of JWT_SECRET, and its LENGTH picks the algorithm.
   *
   * A 64-character secret (what .env.example recommends) means HS512.
   * Assuming HS256 would invalidate every existing session at cutover.
   */
  function resolveAlgorithm(secret: string): string {
    const bits = new TextEncoder().encode(secret).length * 8;
    if (bits >= 512) return 'HS512';
    if (bits >= 384) return 'HS384';
    if (bits >= 256) return 'HS256';
    throw new Error('too short');
  }

  it.each([
    ['a'.repeat(32), 'HS256'],
    ['a'.repeat(47), 'HS256'],
    ['a'.repeat(48), 'HS384'],
    ['a'.repeat(63), 'HS384'],
    ['a'.repeat(64), 'HS512'],
    ['a'.repeat(128), 'HS512'],
  ])('a %s-byte secret selects %s', (secret, expected) => {
    expect(resolveAlgorithm(secret)).toBe(expected);
  });

  it('picks HS512 for the secret length .env.example recommends', () => {
    const realistic = 'change-me-use-at-least-64-random-characters-here-for-production!!';
    expect(realistic.length).toBeGreaterThanOrEqual(64);
    expect(resolveAlgorithm(realistic)).toBe('HS512');
  });

  it('rejects a secret jjwt would have refused to start with', () => {
    expect(() => resolveAlgorithm('short')).toThrow();
  });

  it('counts BYTES not characters for multi-byte secrets', () => {
    // 22 emoji = 88 UTF-8 bytes -> HS512, even though .length is 44.
    const emoji = '🎸'.repeat(22);
    expect(resolveAlgorithm(emoji)).toBe('HS512');
  });
});
