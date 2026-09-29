import type { MarketplaceAccountRow } from '../../db/types.js';
import { readCredentials } from '../../security/credential-encryptor.js';
import type { MarketplaceAuthProvider } from '../types.js';

/**
 * Gear Exchange uses a static personal token — no OAuth handshake, no expiry,
 * no refresh. The seller generates it on Gear Exchange (Sold Items → API
 * Settings) and pastes it into Gearline's "Connect Gear Exchange" dialog, which
 * stores it through the generic create-account endpoint like Reverb's PAT.
 *
 * The OAuth half of the interface is therefore unreachable. It throws with an
 * explanation rather than returning something plausible, so a routing mistake
 * that sends Gear Exchange down an OAuth path fails loudly.
 */
export const gearExchangeAuthProvider: MarketplaceAuthProvider = {
  buildAuthorizationUrl(): string {
    throw new Error(
      'Gear Exchange does not use OAuth — connect it with an API token from the Marketplaces page.',
    );
  },

  async exchangeCodeForTokens(): Promise<Record<string, string>> {
    throw new Error('Gear Exchange does not use OAuth — there is no authorization code to exchange.');
  },

  /**
   * Nothing to refresh. A rejected token (401) surfaces as a permanent error
   * from the API call itself, telling the operator to generate a new one.
   */
  async refreshAccessToken(): Promise<void> {
    // Intentionally empty.
  },

  async areCredentialsValid(account: MarketplaceAccountRow): Promise<boolean> {
    const token = readCredentials(account.encrypted_credentials)['access_token'];
    return typeof token === 'string' && token.trim() !== '';
  },
};
