import { Router } from 'express';
import { z } from 'zod';

import { db, sql } from '../db/index.js';
import { jsonMerge, toJson } from '../db/json.js';
import type { PricingProfileRow } from '../db/types.js';
import { toMarketplaceAccountDto } from '../dto/mappers.js';
import {
  ApiError,
  asyncHandler,
  OptimisticLockError,
  ResourceNotFoundError,
} from '../http/errors.js';
import { loggerFor } from '../logger.js';
import { getConnector, hasConnector } from '../marketplace/registry.js';
import { syncAllProducts } from '../marketplace/shopify/initial-sync.js';
import { getShippingProfiles as getReverbShippingProfiles } from '../marketplace/reverb/client.js';
import * as ebayClient from '../marketplace/ebay/client.js';
import { backfillListingsForNewAccount } from '../services/listing-backfill.js';
import { encrypt } from '../security/credential-encryptor.js';

const log = loggerFor('marketplace-accounts');

/**
 * Port of MarketplaceAccountController. Mounted at /api/v1/marketplace/accounts.
 *
 * Only the endpoints that touch nothing but the database are implemented here.
 * The connector-backed ones (health-check, sync-products, the eBay config and
 * category lookups, Reverb shipping profiles, and account creation with listing
 * backfill) stay on the Java service under the strangler routing — they call
 * live marketplace APIs and depend on the connector layer.
 *
 * They are declared at the bottom returning 501 so a routing mistake surfaces
 * as an obvious error rather than a confusing 404.
 */
export const marketplaceAccountsRouter: Router = Router();

const uuidSchema = z.string().uuid('must be a valid UUID');

async function loadProfile(profileId: string | null): Promise<PricingProfileRow | null> {
  if (!profileId) return null;
  const row = await db
    .selectFrom('pricing_profiles')
    .selectAll()
    .where('id', '=', profileId)
    .executeTakeFirst();
  return row ?? null;
}

// ── GET / ────────────────────────────────────────────────────────────────────

marketplaceAccountsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const accounts = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute();

    // Resolve every referenced pricing profile in one query rather than one per
    // account (the Java version did a lookup per row).
    const profileIds = [
      ...new Set(accounts.map((a) => a.pricing_profile_id).filter((id): id is string => id !== null)),
    ];

    const profiles = profileIds.length
      ? await db.selectFrom('pricing_profiles').selectAll().where('id', 'in', profileIds).execute()
      : [];

    const profileById = new Map(profiles.map((p) => [p.id, p]));

    res.json(
      accounts.map((a) =>
        toMarketplaceAccountDto(a, a.pricing_profile_id ? profileById.get(a.pricing_profile_id) : null),
      ),
    );
  }),
);

// ── GET /:id ─────────────────────────────────────────────────────────────────

marketplaceAccountsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const account = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!account) throw new ResourceNotFoundError('MarketplaceAccount', id);

    res.json(toMarketplaceAccountDto(account, await loadProfile(account.pricing_profile_id)));
  }),
);

// ── PATCH /:id/toggle ────────────────────────────────────────────────────────

/**
 * Enable/disable an account. `active` arrives as a QUERY parameter, not a body
 * field — matching @RequestParam boolean active. The frontend calls
 * `api.patch('/marketplace/accounts/${id}/toggle?active=false')`.
 */
marketplaceAccountsRouter.patch(
  '/:id/toggle',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const activeRaw = req.query.active;

    if (activeRaw === undefined) {
      throw new ApiError(400, 'Missing parameter', "Required query parameter 'active' is not present");
    }

    const active = String(activeRaw) === 'true';

    const patch: Record<string, unknown> = { active, updated_at: new Date() };
    // Disabling an account also marks it disconnected; enabling does not
    // presume connectivity, so the status is left alone in that direction.
    if (!active) patch.connection_status = 'DISCONNECTED';

    const saved = await db
      .updateTable('marketplace_accounts')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!saved) throw new ResourceNotFoundError('MarketplaceAccount', id);

    res.json(toMarketplaceAccountDto(saved, await loadProfile(saved.pricing_profile_id)));
  }),
);

// ── PATCH /:id/pricing-profile ───────────────────────────────────────────────

const assignProfileSchema = z.object({ pricingProfileId: uuidSchema.nullable() });

marketplaceAccountsRouter.patch(
  '/:id/pricing-profile',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const { pricingProfileId } = assignProfileSchema.parse(req.body);

    // Validate the target profile exists before assigning, so a bad id gives a
    // 404 rather than an opaque FK violation.
    const profile = await loadProfile(pricingProfileId);
    if (pricingProfileId && !profile) {
      throw new ResourceNotFoundError('PricingProfile', pricingProfileId);
    }

    const saved = await db
      .updateTable('marketplace_accounts')
      .set({ pricing_profile_id: pricingProfileId, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!saved) throw new ResourceNotFoundError('MarketplaceAccount', id);

    res.json(toMarketplaceAccountDto(saved, profile));
  }),
);

// ── PATCH /:id/settings ──────────────────────────────────────────────────────

const settingsSchema = z.object({
  excludedTags: z.array(z.string()).nullish(),
  descriptionSuffix: z.string().nullish(),
  ebayMerchantLocationKey: z.string().nullish(),
  ebayFulfillmentPolicyId: z.string().nullish(),
  ebayReturnPolicyId: z.string().nullish(),
});

/**
 * Updates sync_settings with three distinct null/blank behaviours, all carried
 * over from the Java version:
 *
 *   field absent / null  → leave the existing setting untouched
 *   field present, blank → REMOVE the setting
 *   field present, value → store it
 *
 * Excluded tags are normalised (trimmed, lowercased, deduplicated) so tag
 * matching downstream is a plain string comparison.
 */
marketplaceAccountsRouter.patch(
  '/:id/settings',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const body = settingsSchema.parse(req.body);

    const account = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!account) throw new ResourceNotFoundError('MarketplaceAccount', id);

    const merge: Record<string, unknown> = {};
    const removeKeys: string[] = [];

    if (body.excludedTags != null) {
      const normalised = [
        ...new Set(
          body.excludedTags
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t !== ''),
        ),
      ];
      merge['excluded_tags'] = normalised;
    }

    const stringSettings: Array<[string | null | undefined, string]> = [
      [body.descriptionSuffix, 'description_suffix'],
      [body.ebayMerchantLocationKey, 'ebay_merchant_location_key'],
      [body.ebayFulfillmentPolicyId, 'ebay_fulfillment_policy_id'],
      [body.ebayReturnPolicyId, 'ebay_return_policy_id'],
    ];

    for (const [value, key] of stringSettings) {
      if (value == null) continue; // absent — no-op
      const trimmed = value.trim();
      if (trimmed === '') removeKeys.push(key);
      else merge[key] = trimmed;
    }

    let saved;

    if (removeKeys.length === 0) {
      // Pure additions — merge server-side with `||` so two concurrent PATCHes
      // touching different keys cannot clobber one another.
      saved = await db
        .updateTable('marketplace_accounts')
        .set({ sync_settings: jsonMerge('sync_settings', merge), updated_at: new Date() })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
    } else {
      /**
       * A removal cannot be expressed with `||`, so the document is rewritten
       * from the copy we read above. That makes this branch read-modify-write,
       * with the usual lost-update window if two settings PATCHes for the SAME
       * account overlap within a few milliseconds.
       *
       * Guarded with an optimistic-lock predicate on `version`: if another
       * writer moved the row first, the UPDATE matches nothing and we surface a
       * 409 telling the client to retry, rather than silently discarding their
       * change. This is a settings screen driven by one operator at a time, so
       * a conflict here is rare and retrying is cheap.
       */
      const next = { ...(account.sync_settings ?? {}) };
      for (const key of removeKeys) delete next[key];
      Object.assign(next, merge);

      saved = await db
        .updateTable('marketplace_accounts')
        .set({
          sync_settings: toJson(next),
          version: sql<string>`version + 1`,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .where('version', '=', account.version)
        .returningAll()
        .executeTakeFirst();

      if (!saved) throw new OptimisticLockError();
    }

    if (!saved) throw new ResourceNotFoundError('MarketplaceAccount', id);

    res.json(toMarketplaceAccountDto(saved, await loadProfile(saved.pricing_profile_id)));
  }),
);

// ── POST /:id/health-check ───────────────────────────────────────────────────

/**
 * Tests live connectivity and records the outcome on the account, so the
 * Marketplaces page reflects reality rather than the last known state.
 */
marketplaceAccountsRouter.post(
  '/:id/health-check',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const account = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!account) throw new ResourceNotFoundError('MarketplaceAccount', id);

    if (!hasConnector(account.marketplace_type)) {
      // Not an error — that marketplace is simply still served by Java.
      res.json({
        healthy: false,
        message: 'No connector registered',
        marketplaceType: account.marketplace_type,
      });
      return;
    }

    const result = await getConnector(account.marketplace_type).checkHealth(account);

    await db
      .updateTable('marketplace_accounts')
      .set({
        connection_status: result.healthy ? 'CONNECTED' : 'ERROR',
        last_error: result.healthy ? null : result.message,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();

    res.json(result);
  }),
);

// ── POST /:id/sync-products ──────────────────────────────────────────────────

/**
 * Triggers the one-off bulk catalogue import. Shopify only — it is the sole
 * product source.
 *
 * Returns 202 immediately and runs detached: a large catalogue takes minutes,
 * and the import is idempotent so it can simply be re-run.
 */
marketplaceAccountsRouter.post(
  '/:id/sync-products',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const account = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!account) throw new ResourceNotFoundError('MarketplaceAccount', id);

    if (account.marketplace_type !== 'SHOPIFY') {
      res.status(400).json({ error: 'Product sync is only available for Shopify accounts' });
      return;
    }

    void syncAllProducts(account).catch((err: unknown) => {
      log.error({ err, accountId: id }, 'Initial product sync failed');
    });

    res.status(202).json({
      message: 'Product sync started. Products will appear in Gearline as they are imported.',
    });
  }),
);

// ── GET /:id/reverb/shipping-profiles ────────────────────────────────────────

marketplaceAccountsRouter.get(
  '/:id/reverb/shipping-profiles',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);

    const account = await db
      .selectFrom('marketplace_accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!account) throw new ResourceNotFoundError('MarketplaceAccount', id);

    if (account.marketplace_type !== 'REVERB') {
      res.status(400).end();
      return;
    }

    // Already slimmed to { id, name } by the client — the id is what gets sent
    // as shipping_profile_id when publishing.
    res.json(await getReverbShippingProfiles(account));
  }),
);

// ── eBay account configuration ───────────────────────────────────────────────

/** Loads an eBay account or sends the appropriate error. Returns null if handled. */
async function requireEbayAccount(id: string) {
  const account = await db
    .selectFrom('marketplace_accounts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  if (!account) throw new ResourceNotFoundError('MarketplaceAccount', id);
  return account;
}

/**
 * Locations, fulfilment policies and return policies in one call — these
 * populate three dropdowns on the Marketplaces settings screen.
 *
 * Fetched in parallel. A failure in any one returns 502 with the message, since
 * a half-populated settings form is worse than a clear error.
 */
marketplaceAccountsRouter.get(
  '/:id/ebay/config',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const account = await requireEbayAccount(id);

    if (account.marketplace_type !== 'EBAY') {
      res.status(400).end();
      return;
    }

    try {
      const [locations, fulfillmentPolicies, returnPolicies] = await Promise.all([
        ebayClient.getMerchantLocations(account),
        ebayClient.getFulfillmentPolicies(account),
        ebayClient.getReturnPolicies(account),
      ]);

      res.json({
        locations: locations.map((l) => ({
          key: l['merchantLocationKey'] ?? '',
          // eBay omits `name` on locations created without one; fall back to
          // the key so the dropdown is never blank.
          name: l['name'] ?? l['merchantLocationKey'] ?? '',
          status: l['merchantLocationStatus'] ?? '',
        })),
        fulfillmentPolicies: fulfillmentPolicies.map((p) => ({
          id: p['fulfillmentPolicyId'] ?? '',
          name: p['name'] ?? '',
        })),
        returnPolicies: returnPolicies.map((p) => ({
          id: p['returnPolicyId'] ?? '',
          name: p['name'] ?? '',
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, accountId: id }, 'eBay config fetch failed');
      res.status(502).json({ error: message });
    }
  }),
);

marketplaceAccountsRouter.get(
  '/:id/ebay/category-suggestions',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const q = typeof req.query.q === 'string' ? req.query.q : '';

    const account = await requireEbayAccount(id);

    if (account.marketplace_type !== 'EBAY') {
      res.status(400).end();
      return;
    }

    try {
      const suggestions = await ebayClient.getCategorySuggestions(account, q);

      res.json(
        suggestions.map((s) => {
          const category = s['category'];
          const cat =
            typeof category === 'object' && category !== null
              ? (category as Record<string, unknown>)
              : {};

          return {
            categoryId: cat['categoryId'] ?? '',
            categoryName: cat['categoryName'] ?? '',
            level: s['categoryTreeNodeLevel'] ?? 0,
          };
        }),
      );
    } catch (err) {
      // Returns an empty array rather than an error object — the Java version
      // did the same, and the UI renders it as "no matches".
      log.warn({ err, accountId: id, q }, 'eBay category search failed');
      res.status(502).json([]);
    }
  }),
);

const createLocationSchema = z.object({
  key: z.string().min(1, 'Location key is required').max(36),
  name: z.string().min(1, 'Location name is required'),
  addressLine1: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  postalCode: z.string().nullish(),
});

marketplaceAccountsRouter.post(
  '/:id/ebay/location',
  asyncHandler(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const account = await requireEbayAccount(id);

    if (account.marketplace_type !== 'EBAY') {
      res.status(400).end();
      return;
    }

    const parsed = createLocationSchema.safeParse(req.body);

    if (!parsed.success) {
      // Matches the Java shape: a plain { error } rather than a ProblemDetail.
      const first = parsed.error.errors[0];
      res.status(400).json({ error: first?.message ?? 'Invalid request' });
      return;
    }

    const body = parsed.data;

    try {
      await ebayClient.createMerchantLocation(
        account,
        body.key,
        body.name,
        body.addressLine1 ?? null,
        body.city ?? null,
        body.state ?? null,
        body.postalCode ?? null,
      );

      res.json({ key: body.key.trim(), name: body.name.trim(), status: 'ENABLED' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, accountId: id }, 'eBay create location failed');
      res.status(502).json({ error: message });
    }
  }),
);

// ── POST / — manual account creation ─────────────────────────────────────────

const createAccountSchema = z.object({
  marketplaceType: z.enum(['SHOPIFY', 'EBAY', 'REVERB']),
  displayName: z.string().min(1, 'must not be blank'),
  credentials: z.record(z.string()).nullish(),
});

/**
 * Creates an account directly, for PAT-based connectors such as Reverb where
 * there is no OAuth handshake to go through.
 *
 * Credentials are encrypted on the way in — the plaintext never reaches the
 * database, and the DTO never returns them.
 */
marketplaceAccountsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createAccountSchema.parse(req.body);

    const account = await db
      .insertInto('marketplace_accounts')
      .values({
        marketplace_type: body.marketplaceType,
        display_name: body.displayName,
        encrypted_credentials: encrypt(body.credentials ?? {}),
        connection_status: 'CONNECTED',
        active: true,
        sync_settings: toJson({}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    /**
     * Backfill NEEDS_REVIEW stubs for the existing catalogue.
     *
     * Shopify is skipped: it is the product SOURCE, not a listing destination,
     * so creating listing stubs against it would be meaningless rows the
     * dispatcher then has to keep skipping.
     *
     * Detached — a large catalogue takes a while and the UI should not block.
     * It is idempotent (ON CONFLICT DO NOTHING), so a partial run is safe to
     * repeat.
     */
    if (account.marketplace_type !== 'SHOPIFY') {
      void backfillListingsForNewAccount(account).catch((err: unknown) => {
        log.error({ err, accountId: account.id }, 'Listing backfill failed');
      });
    }

    res
      .status(201)
      .location(`/api/v1/marketplace/accounts/${account.id}`)
      .json(toMarketplaceAccountDto(account, null));
  }),
);
