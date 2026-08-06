import { config } from '../config.js';
import { db } from '../db/index.js';
import { loggerFor } from '../logger.js';
import { hashPassword } from '../security/password.js';

const log = loggerFor('bootstrap');

/**
 * Port of DataInitializer.
 *
 * Runs once at startup to guarantee at least one admin account exists.
 *
 *   ADMIN_EMAIL + ADMIN_PASSWORD set → upsert that account as an active ADMIN.
 *                                      Idempotent, so redeploying is how you
 *                                      rotate the admin password.
 *   Neither set                      → do nothing; the Flyway V8 seed
 *                                      (admin@gearline.io) is the fallback.
 *                                      Warn if the users table is empty, since
 *                                      the app is then unusable.
 *
 * ── Important during the strangler cutover ───────────────────────────────────
 *
 * Both backends run this on boot against the same database and the same
 * environment variables. That is safe precisely because the operation is an
 * idempotent upsert producing an equivalent result either way — the only
 * difference is which service's bcrypt wrote the hash, and both produce $2a$
 * hashes the other can verify.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const email = config.bootstrap.adminEmail.trim();
  const password = config.bootstrap.adminPassword;

  if (email === '' || password === '') {
    const countRow = await db
      .selectFrom('users')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirst();

    const userCount = Number.parseInt(countRow?.count ?? '0', 10);

    if (userCount === 0) {
      log.warn(
        'No users found and ADMIN_EMAIL/ADMIN_PASSWORD are not set. The application ' +
          'has no accounts — set these environment variables and redeploy.',
      );
    } else {
      log.debug({ userCount }, 'Users present, no bootstrap action required');
    }
    return;
  }

  const hash = await hashPassword(password);

  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable('users')
      .set({ password_hash: hash, role: 'ADMIN', active: true, updated_at: new Date() })
      .where('id', '=', existing.id)
      .execute();

    log.info({ email }, 'Updated bootstrap admin account');
    return;
  }

  await db
    .insertInto('users')
    .values({
      email,
      password_hash: hash,
      first_name: 'Admin',
      last_name: '',
      role: 'ADMIN',
      active: true,
    })
    // Two instances booting simultaneously (as happens during a blue/green
    // swap) would otherwise race on the unique email constraint.
    .onConflict((oc) => oc.column('email').doNothing())
    .execute();

  log.info({ email }, 'Created bootstrap admin account');
}
