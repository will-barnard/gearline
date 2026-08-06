/**
 * Cross-language credential compatibility check.
 *
 * Run this ONCE against production data before cutting any traffic over. It is
 * the single check that catches an encryption mismatch before it silently drops
 * every marketplace connection.
 *
 *     CREDENTIAL_ENCRYPTION_KEY=<prod key> \
 *     SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5432/gearline \
 *     SPRING_DATASOURCE_USERNAME=gearline \
 *     SPRING_DATASOURCE_PASSWORD=<pw> \
 *     npx tsx scripts/verify-credentials.ts
 *
 * It reads every marketplace_accounts row, decrypts the credentials blob that
 * the JAVA service wrote, and reports whether the Node implementation can read
 * it. Token VALUES are never printed — only key names and lengths.
 *
 * Read-only. It never writes to the database.
 */

import { db, closeDatabase } from '../src/db/index.js';
import { decrypt, encryptionEnabled } from '../src/security/credential-encryptor.js';

async function main(): Promise<void> {
  console.log(`Encryption mode: ${encryptionEnabled ? 'AES-256-GCM' : 'PASS-THROUGH (no key set)'}`);

  if (!encryptionEnabled) {
    console.warn(
      '\nCREDENTIAL_ENCRYPTION_KEY is not set. This run only proves that plain-JSON\n' +
        'credentials parse. To verify the real production format, re-run with the\n' +
        'production key set.\n',
    );
  }

  const accounts = await db
    .selectFrom('marketplace_accounts')
    .select([
      'id',
      'marketplace_type',
      'display_name',
      'encrypted_credentials',
      'connection_status',
    ])
    .execute();

  if (accounts.length === 0) {
    console.log('\nNo marketplace accounts found — nothing to verify.');
    return;
  }

  console.log(`\nChecking ${accounts.length} marketplace account(s):\n`);

  let ok = 0;
  let empty = 0;
  const failures: Array<{ id: string; name: string; error: string }> = [];

  for (const account of accounts) {
    const label = `${account.marketplace_type.padEnd(7)} ${account.display_name}`;

    if (account.encrypted_credentials === null) {
      console.log(`  --  ${label}  (no credentials stored)`);
      empty++;
      continue;
    }

    try {
      const credentials = decrypt(account.encrypted_credentials);
      const keys = Object.keys(credentials ?? {});

      // Key names and value lengths only — never the values themselves.
      const summary = keys.map((k) => `${k}(${String(credentials?.[k] ?? '').length})`).join(', ');
      console.log(`  OK  ${label}  -> ${keys.length} key(s): ${summary}`);
      ok++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  !!  ${label}  -> FAILED: ${message}`);
      failures.push({ id: account.id, name: account.display_name, error: message });
    }
  }

  console.log(`\n${'-'.repeat(70)}`);
  console.log(`Readable: ${ok}   Empty: ${empty}   Failed: ${failures.length}`);

  if (failures.length > 0) {
    console.error(
      '\nDO NOT CUT OVER.\n\n' +
        'The Node service cannot read credentials the Java service wrote. Every\n' +
        'listed account would lose its marketplace connection. Most likely causes:\n\n' +
        '  1. CREDENTIAL_ENCRYPTION_KEY differs between the two services.\n' +
        '  2. The blob was written in pass-through mode (no key) and is plain JSON,\n' +
        '     while this run has a key set — or the reverse.\n' +
        '  3. The key is longer than 32 bytes and is being truncated differently.\n',
    );
    process.exitCode = 1;
    return;
  }

  console.log('\nAll stored credentials are readable by the Node implementation.');
}

main()
  .catch((err: unknown) => {
    console.error('Verification failed to run:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
