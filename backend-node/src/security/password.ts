import bcrypt from 'bcryptjs';

/**
 * Password hashing, compatible with Spring Security's BCryptPasswordEncoder(12).
 *
 * Spring emits `$2a$` prefixed hashes at cost 12. bcryptjs both verifies `$2a$`
 * and emits `$2a$` by default, so hashes round-trip in either direction: a user
 * whose password was set by the Java service can log in here, and one created
 * here can log in there. That two-way compatibility is what makes it safe to
 * run both backends at once during the strangler cutover.
 *
 * Cost 12 is ~250ms per hash on typical hardware. That is deliberate (it is what
 * makes offline cracking expensive) but it is also blocking CPU work on a
 * single-threaded runtime, so we use the async API throughout — bcryptjs then
 * chunks the work across ticks instead of stalling the event loop for a quarter
 * of a second on every login.
 */

const BCRYPT_COST = 12;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  // bcryptjs rejects malformed hashes by throwing; a corrupt stored hash should
  // read as "wrong password", not as a 500.
  return bcrypt.compare(plaintext, hash).catch(() => false);
}
