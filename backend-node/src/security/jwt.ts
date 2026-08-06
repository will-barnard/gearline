import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import { config } from '../config.js';
import { loggerFor } from '../logger.js';
import type { UserRole } from '../db/types.js';

const log = loggerFor('jwt');

/**
 * Wire-compatible reimplementation of JwtTokenService.
 *
 * ── Why the algorithm is chosen by secret LENGTH ─────────────────────────────
 *
 * The Java signingKey() reads:
 *
 *     byte[] keyBytes = Decoders.BASE64.decode(
 *         Base64.getEncoder().encodeToString(secret.getBytes()));
 *     return Keys.hmacShaKeyFor(keyBytes);
 *
 * The Base64 encode immediately followed by a Base64 decode is a no-op round
 * trip, so keyBytes is simply the raw UTF-8 bytes of JWT_SECRET — NOT a decoded
 * Base64 secret. Easy to misread; getting it wrong changes the key entirely.
 *
 * jjwt's Keys.hmacShaKeyFor() then picks the HMAC variant from the key size:
 *
 *     >= 512 bits (64 bytes) -> HS512
 *     >= 384 bits (48 bytes) -> HS384
 *     >= 256 bits (32 bytes) -> HS256
 *     <  256 bits            -> throws WeakKeyException
 *
 * So a 64-character JWT_SECRET (what .env.example recommends) yields HS512, not
 * HS256. Hard-coding HS256 here would produce tokens the Java service rejects
 * and reject every token it issued — logging out every user at cutover, in both
 * directions, with no obvious cause. We therefore derive the algorithm from the
 * secret exactly as jjwt does.
 */
function resolveAlgorithm(keyBytes: Uint8Array): 'HS256' | 'HS384' | 'HS512' {
  const bits = keyBytes.length * 8;

  if (bits >= 512) return 'HS512';
  if (bits >= 384) return 'HS384';
  if (bits >= 256) return 'HS256';

  throw new Error(
    `JWT_SECRET is ${keyBytes.length} bytes (${bits} bits). jjwt requires at least ` +
      '32 bytes (256 bits) and would have refused to start. Use a longer secret — ' +
      'note that changing it will invalidate all existing tokens.',
  );
}

const secretKey = new TextEncoder().encode(config.jwt.secret);
const algorithm = resolveAlgorithm(secretKey);

log.info(
  { algorithm, secretBytes: secretKey.length },
  'JWT signing configured (algorithm derived from secret length, matching jjwt)',
);

export type TokenType = 'access' | 'refresh';

export interface GearlineClaims extends JWTPayload {
  email: string;
  role: UserRole;
  type: TokenType;
}

export interface TokenSubject {
  id: string;
  email: string;
  role: UserRole;
}

/**
 * Builds a token with the same claim set the Java service emits:
 *   jti  — random UUID
 *   sub  — user id
 *   iat  — issued at (seconds)
 *   exp  — expiry (seconds)
 *   email, role, type — custom claims
 *
 * jjwt writes iat/exp as NumericDate (seconds since epoch), which is what
 * setIssuedAt/setExpirationTime produce here too.
 */
async function buildToken(user: TokenSubject, expiryMs: number, type: TokenType): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  return new SignJWT({ email: user.email, role: user.role, type })
    .setProtectedHeader({ alg: algorithm })
    .setJti(crypto.randomUUID())
    .setSubject(user.id)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + Math.floor(expiryMs / 1000))
    .sign(secretKey);
}

export function generateAccessToken(user: TokenSubject): Promise<string> {
  return buildToken(user, config.jwt.accessTokenExpiryMs, 'access');
}

export function generateRefreshToken(user: TokenSubject): Promise<string> {
  return buildToken(user, config.jwt.refreshTokenExpiryMs, 'refresh');
}

/**
 * Verifies a token and returns its claims.
 *
 * Throws on any failure (bad signature, expired, malformed) — callers decide
 * how to translate that into a response, mirroring how the Java code let
 * JwtException bubble to GlobalExceptionHandler.
 *
 * Note we pass the single resolved algorithm rather than a permissive list:
 * accepting multiple algorithms would let an attacker who learns the secret
 * downgrade to a weaker HMAC variant.
 */
export async function validateAndExtractClaims(token: string): Promise<GearlineClaims> {
  const { payload } = await jwtVerify(token, secretKey, { algorithms: [algorithm] });
  return payload as GearlineClaims;
}

export function isAccessToken(claims: GearlineClaims): boolean {
  return claims.type === 'access';
}

export function isRefreshToken(claims: GearlineClaims): boolean {
  return claims.type === 'refresh';
}

export function extractUserId(claims: GearlineClaims): string {
  if (!claims.sub) throw new Error('Token has no subject claim');
  return claims.sub;
}

export async function isTokenValid(token: string): Promise<boolean> {
  try {
    await validateAndExtractClaims(token);
    return true;
  } catch (err) {
    log.debug({ err }, 'JWT validation failed');
    return false;
  }
}

/** Exposed for the parity test suite. */
export const __internals = { resolveAlgorithm, algorithm };
