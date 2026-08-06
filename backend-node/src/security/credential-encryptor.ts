import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { config } from '../config.js';
import { loggerFor } from '../logger.js';

const log = loggerFor('credential-encryptor');

/**
 * AES-256-GCM credential encryptor, byte-for-byte compatible with the Java
 * CredentialEncryptor.
 *
 * ── Wire format ──────────────────────────────────────────────────────────────
 *
 *     Base64( IV(12 bytes) || ciphertext || GCM tag(16 bytes) )
 *
 * The subtlety: Java's Cipher APPENDS the 16-byte GCM authentication tag to the
 * ciphertext returned by doFinal(), so the tag is part of what gets Base64'd.
 * Node's crypto keeps the tag separate via getAuthTag()/setAuthTag(). To read
 * what Java wrote we must split the trailing 16 bytes off ourselves and feed
 * them to setAuthTag(); to write something Java can read we must concatenate
 * them back on. Get this wrong and every stored OAuth token becomes unreadable
 * — which in practice means silently losing every marketplace connection.
 *
 * ── Pass-through mode ────────────────────────────────────────────────────────
 *
 * When CREDENTIAL_ENCRYPTION_KEY is blank the Java version stores plain JSON and
 * reads it back as plain JSON. We reproduce that exactly, including the warning,
 * so a dev database written by one service is readable by the other.
 */

const GCM_IV_LENGTH = 12; // bytes
const GCM_TAG_LENGTH = 16; // bytes (128 bits)
const ALGORITHM = 'aes-256-gcm';

export type Credentials = Record<string, string>;

function resolveKey(): Buffer | null {
  const raw = config.credential.encryptionKey?.trim();

  if (!raw) {
    log.warn(
      'CREDENTIAL_ENCRYPTION_KEY is not set — marketplace credentials will be ' +
        'stored unencrypted. Set this variable before deploying to production.',
    );
    return null;
  }

  const keyBytes = Buffer.from(raw, 'base64');

  if (keyBytes.length < 32) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must decode to at least 32 bytes (256-bit AES key). ' +
        'Generate one with: openssl rand -base64 32',
    );
  }

  // Java takes exactly the first 32 bytes when a longer key is supplied.
  // Truncating identically matters: a 48-byte key would otherwise produce a
  // different cipher key here than in Java and decryption would fail.
  return keyBytes.subarray(0, 32);
}

const secretKey = resolveKey();
export const encryptionEnabled = secretKey !== null;

if (encryptionEnabled) {
  log.info('Credential encryption enabled (AES-256-GCM)');
}

/**
 * Encrypts a credential map. Returns plain JSON when encryption is disabled.
 * Returns null for null input, matching the Java contract.
 */
export function encrypt(credentials: Credentials | null): string | null {
  if (credentials === null || credentials === undefined) return null;

  const json = JSON.stringify(credentials);
  if (!secretKey) return json;

  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, secretKey, iv, { authTagLength: GCM_TAG_LENGTH });

  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // IV || ciphertext || tag — the tag goes last because that is where Java's
  // Cipher.doFinal() puts it.
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

/**
 * Decrypts a stored credential blob back into a map.
 * Throws if the payload is malformed or the tag does not verify.
 */
export function decrypt(stored: string | null): Credentials | null {
  if (stored === null || stored === undefined) return null;

  if (!secretKey) {
    return JSON.parse(stored) as Credentials;
  }

  const combined = Buffer.from(stored, 'base64');

  if (combined.length < GCM_IV_LENGTH + GCM_TAG_LENGTH) {
    throw new Error(
      `Stored credential blob is ${combined.length} bytes — too short to contain ` +
        `a ${GCM_IV_LENGTH}-byte IV and a ${GCM_TAG_LENGTH}-byte GCM tag. ` +
        'The value may have been written in pass-through (unencrypted) mode; ' +
        'check whether CREDENTIAL_ENCRYPTION_KEY was set when it was saved.',
    );
  }

  const iv = combined.subarray(0, GCM_IV_LENGTH);
  const authTag = combined.subarray(combined.length - GCM_TAG_LENGTH);
  const ciphertext = combined.subarray(GCM_IV_LENGTH, combined.length - GCM_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, secretKey, iv, { authTagLength: GCM_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as Credentials;
}

/**
 * Reads credentials off a marketplace account row, returning {} rather than
 * throwing when the column is null. Most call sites want a map they can index.
 */
export function readCredentials(stored: string | null): Credentials {
  return decrypt(stored) ?? {};
}
